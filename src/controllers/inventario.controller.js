import { pool } from '../config/db.js';

const normalizarLote = (lote) => {
  if (!lote || !lote.trim()) {
    return 'SIN-LOTE';
  }

  return lote.trim().toUpperCase();
};

const normalizarBooleano = (valor, valorDefault = false) => {
  if (valor === undefined || valor === null || valor === '') {
    return valorDefault;
  }

  if (typeof valor === 'boolean') return valor;

  return ['true', '1', 'si', 'sí', 's'].includes(
    String(valor).trim().toLowerCase()
  );
};

const normalizarTextoNullable = (valor) => {
  const texto = String(valor ?? '').trim();
  return texto ? texto : null;
};

const configuracionVariantesDefault = {
  talla: false,
  color: false,
  tono: false,
  genero: false,
  presentacion: false,
  material: false,
  modelo: false,
  aroma: false,
  capacidad: false,
  personalizados: [],
};

const normalizarConfiguracionVariantes = (valor) => {
  let origen = valor;

  if (typeof origen === 'string') {
    try {
      origen = JSON.parse(origen);
    } catch {
      origen = {};
    }
  }

  if (!origen || typeof origen !== 'object' || Array.isArray(origen)) {
    origen = {};
  }

  return {
    ...configuracionVariantesDefault,
    ...origen,
    personalizados: Array.isArray(origen.personalizados)
      ? origen.personalizados
          .map((item) => ({
            clave: String(item?.clave || '').trim(),
            etiqueta: String(item?.etiqueta || '').trim(),
          }))
          .filter((item) => item.clave && item.etiqueta)
      : [],
  };
};

const obtenerClavesVariantesConfiguradas = (configuracion) => {
  const config = normalizarConfiguracionVariantes(configuracion);

  const base = [
    'talla',
    'color',
    'tono',
    'genero',
    'presentacion',
    'material',
    'modelo',
    'aroma',
    'capacidad',
  ].filter((clave) => normalizarBooleano(config[clave], false));

  const personalizados = (config.personalizados || []).map(
    (item) => item.clave
  );

  return [...base, ...personalizados];
};

const normalizarAtributosEntrada = (
  variante,
  configuracionVariantes
) => {
  const claves = obtenerClavesVariantesConfiguradas(
    configuracionVariantes
  );

  const origen =
    variante?.atributos &&
    typeof variante.atributos === 'object' &&
    !Array.isArray(variante.atributos)
      ? variante.atributos
      : {};

  const atributos = {};

  for (const clave of claves) {
    const valorDirecto = variante?.[clave];
    const valor = normalizarTextoNullable(
      valorDirecto ?? origen?.[clave]
    );

    if (!valor) {
      const error = new Error(
        `Falta capturar el atributo "${clave}" en una variante`
      );
      error.statusCode = 400;
      throw error;
    }

    atributos[clave] = valor;
  }

  return atributos;
};

const obtenerNombreVarianteDesdeAtributos = (
  variante,
  atributos,
  configuracionVariantes
) => {
  const nombreManual = normalizarTextoNullable(
    variante?.nombre_variante
  );

  if (nombreManual) return nombreManual;

  const claves = obtenerClavesVariantesConfiguradas(
    configuracionVariantes
  );

  return (
    claves
      .map((clave) => atributos?.[clave])
      .filter(Boolean)
      .join(' · ') || 'Variante'
  );
};

const buscarOCrearVariante = async ({
  client,
  producto,
  variante,
}) => {
  const atributos = normalizarAtributosEntrada(
    variante,
    producto.configuracion_variantes
  );

  const talla = normalizarTextoNullable(
    variante?.talla ?? atributos.talla
  );
  const color = normalizarTextoNullable(
    variante?.color ?? atributos.color
  );
  const tono = normalizarTextoNullable(
    variante?.tono ?? atributos.tono
  );
  const presentacion = normalizarTextoNullable(
    variante?.presentacion ?? atributos.presentacion
  );

  const sku = normalizarTextoNullable(variante?.sku);
  const codigoBarras = normalizarTextoNullable(
    variante?.codigo_barras
  );

  const nombreVariante = obtenerNombreVarianteDesdeAtributos(
    variante,
    atributos,
    producto.configuracion_variantes
  );

  let existente = null;

  const idVarianteSolicitada = Number(variante?.id_variante || 0);

  if (
    Number.isInteger(idVarianteSolicitada) &&
    idVarianteSolicitada > 0
  ) {
    const resultado = await client.query(
      `
        SELECT *
        FROM producto_variantes
        WHERE id_variante = $1
          AND id_producto = $2
        LIMIT 1
      `,
      [idVarianteSolicitada, producto.id_producto]
    );

    existente = resultado.rows[0] || null;
  }

  if (!existente && sku) {
    const resultado = await client.query(
      `
        SELECT *
        FROM producto_variantes
        WHERE id_producto = $1
          AND LOWER(COALESCE(sku, '')) = LOWER($2)
        LIMIT 1
      `,
      [producto.id_producto, sku]
    );

    existente = resultado.rows[0] || null;
  }

  if (!existente && codigoBarras) {
    const resultado = await client.query(
      `
        SELECT *
        FROM producto_variantes
        WHERE id_producto = $1
          AND codigo_barras = $2
        LIMIT 1
      `,
      [producto.id_producto, codigoBarras]
    );

    existente = resultado.rows[0] || null;
  }

  if (!existente) {
    const resultado = await client.query(
      `
        SELECT *
        FROM producto_variantes
        WHERE id_producto = $1
          AND COALESCE(talla, '') = COALESCE($2, '')
          AND COALESCE(color, '') = COALESCE($3, '')
          AND COALESCE(tono, '') = COALESCE($4, '')
          AND COALESCE(presentacion, '') = COALESCE($5, '')
          AND COALESCE(atributos, '{}'::jsonb) = $6::jsonb
        LIMIT 1
      `,
      [
        producto.id_producto,
        talla,
        color,
        tono,
        presentacion,
        JSON.stringify(atributos),
      ]
    );

    existente = resultado.rows[0] || null;
  }

  if (existente) {
    const actualizado = await client.query(
      `
        UPDATE producto_variantes
        SET
          nombre_variante = COALESCE(NULLIF($1, ''), nombre_variante),
          sku = COALESCE(NULLIF($2, ''), sku),
          codigo_barras = COALESCE(NULLIF($3, ''), codigo_barras),
          talla = $4,
          color = $5,
          tono = $6,
          presentacion = $7,
          precio_compra = COALESCE($8, precio_compra),
          precio_venta = COALESCE($9, precio_venta),
          atributos = $10::jsonb,
          activo = true,
          fecha_actualizacion = CURRENT_TIMESTAMP
        WHERE id_variante = $11
        RETURNING *
      `,
      [
        nombreVariante,
        sku,
        codigoBarras,
        talla,
        color,
        tono,
        presentacion,
        variante?.precio_compra !== undefined &&
        variante?.precio_compra !== null &&
        variante?.precio_compra !== ''
          ? Number(variante.precio_compra)
          : null,
        variante?.precio_venta !== undefined &&
        variante?.precio_venta !== null &&
        variante?.precio_venta !== ''
          ? Number(variante.precio_venta)
          : null,
        JSON.stringify(atributos),
        existente.id_variante,
      ]
    );

    return actualizado.rows[0];
  }

  const creado = await client.query(
    `
      INSERT INTO producto_variantes (
        id_producto,
        sku,
        codigo_barras,
        nombre_variante,
        talla,
        color,
        tono,
        presentacion,
        precio_compra,
        precio_venta,
        es_principal,
        activo,
        atributos
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,true,$11::jsonb
      )
      RETURNING *
    `,
    [
      producto.id_producto,
      sku,
      codigoBarras,
      nombreVariante,
      talla,
      color,
      tono,
      presentacion,
      variante?.precio_compra !== undefined &&
      variante?.precio_compra !== null &&
      variante?.precio_compra !== ''
        ? Number(variante.precio_compra)
        : Number(producto.precio_compra || 0),
      variante?.precio_venta !== undefined &&
      variante?.precio_venta !== null &&
      variante?.precio_venta !== ''
        ? Number(variante.precio_venta)
        : Number(producto.precio_venta || 0),
      JSON.stringify(atributos),
    ]
  );

  return creado.rows[0];
};

const obtenerStockVarianteSucursal = async ({
  client,
  idSucursal,
  idProducto,
  idVariante,
}) => {
  const resultado = await client.query(
    `
      SELECT *
      FROM inventario_variantes_sucursal
      WHERE id_sucursal = $1
        AND id_producto = $2
        AND id_variante = $3
      FOR UPDATE
    `,
    [idSucursal, idProducto, idVariante]
  );

  return resultado.rows[0] || null;
};

const sumarStockVarianteSucursal = async ({
  client,
  idSucursal,
  idProducto,
  idVariante,
  cantidad,
  ubicacion,
}) => {
  const actual = await obtenerStockVarianteSucursal({
    client,
    idSucursal,
    idProducto,
    idVariante,
  });

  if (actual) {
    const stockNuevo =
      Number(actual.stock_actual || 0) + Number(cantidad || 0);

    const actualizado = await client.query(
      `
        UPDATE inventario_variantes_sucursal
        SET
          stock_actual = $1,
          ubicacion = COALESCE($2, ubicacion),
          activo = true,
          fecha_actualizacion = CURRENT_TIMESTAMP
        WHERE id_inventario_variante = $3
        RETURNING *
      `,
      [
        stockNuevo,
        normalizarTextoNullable(ubicacion),
        actual.id_inventario_variante,
      ]
    );

    return {
      anterior: Number(actual.stock_actual || 0),
      nuevo: stockNuevo,
      registro: actualizado.rows[0],
    };
  }

  const creado = await client.query(
    `
      INSERT INTO inventario_variantes_sucursal (
        id_sucursal,
        id_producto,
        id_variante,
        stock_actual,
        stock_minimo,
        ubicacion,
        activo
      )
      VALUES ($1,$2,$3,$4,0,$5,true)
      RETURNING *
    `,
    [
      idSucursal,
      idProducto,
      idVariante,
      Number(cantidad || 0),
      normalizarTextoNullable(ubicacion),
    ]
  );

  return {
    anterior: 0,
    nuevo: Number(cantidad || 0),
    registro: creado.rows[0],
  };
};

const sumarStockLote = async ({
  client,
  idSucursal,
  idProducto,
  idVariante = null,
  idProveedor = null,
  lote,
  fechaCaducidad = null,
  cantidad,
  precioCompra = 0,
}) => {
  const resultado = await client.query(
    `
      SELECT *
      FROM inventario_lotes
      WHERE id_sucursal = $1
        AND id_producto = $2
        AND id_variante IS NOT DISTINCT FROM $3::integer
        AND lote = $4
        AND fecha_caducidad IS NOT DISTINCT FROM $5::date
      ORDER BY id_lote ASC
      LIMIT 1
      FOR UPDATE
    `,
    [
      idSucursal,
      idProducto,
      idVariante,
      lote,
      fechaCaducidad,
    ]
  );

  if (resultado.rows.length > 0) {
    const actual = resultado.rows[0];
    const stockNuevo =
      Number(actual.stock_actual || 0) + Number(cantidad || 0);

    const actualizado = await client.query(
      `
        UPDATE inventario_lotes
        SET
          stock_actual = $1,
          id_proveedor = COALESCE($2, id_proveedor),
          precio_compra = COALESCE($3, precio_compra),
          activo = true,
          fecha_actualizacion = CURRENT_TIMESTAMP
        WHERE id_lote = $4
        RETURNING *
      `,
      [
        stockNuevo,
        idProveedor || null,
        precioCompra !== undefined &&
        precioCompra !== null &&
        precioCompra !== ''
          ? Number(precioCompra)
          : null,
        actual.id_lote,
      ]
    );

    return actualizado.rows[0];
  }

  const creado = await client.query(
    `
      INSERT INTO inventario_lotes (
        id_sucursal,
        id_producto,
        id_variante,
        id_proveedor,
        lote,
        fecha_caducidad,
        stock_actual,
        precio_compra,
        activo
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
      RETURNING *
    `,
    [
      idSucursal,
      idProducto,
      idVariante,
      idProveedor || null,
      lote,
      fechaCaducidad,
      Number(cantidad || 0),
      Number(precioCompra || 0),
    ]
  );

  return creado.rows[0];
};

const movimientosEntrada = [
  'ENTRADA',
  'AJUSTE_POSITIVO',
  'DEVOLUCION_CLIENTE',
];

const movimientosSalida = [
  'SALIDA',
  'AJUSTE_NEGATIVO',
  'MERMA',
  'CADUCIDAD',
  'DEVOLUCION_PROVEEDOR',
];

const tiposPermitidos = [
  'ENTRADA',
  'SALIDA',
  'AJUSTE_POSITIVO',
  'AJUSTE_NEGATIVO',
  'MERMA',
  'CADUCIDAD',
  'DEVOLUCION_CLIENTE',
  'DEVOLUCION_PROVEEDOR',
];

export const listarInventarioPorSucursal = async (req, res) => {
  try {
    const {
      sucursal,
      buscar,
      id_producto = '',
      autocomplete = '',
      limit = '',
    } = req.query;

    if (!sucursal) {
      return res.status(400).json({
        ok: false,
        mensaje: 'El parámetro sucursal es obligatorio',
      });
    }

    let query = `
      SELECT
        i.id_inventario,
        i.id_sucursal,
        s.nombre AS sucursal,
        i.id_producto,
        p.codigo_barras,
        p.nombre AS producto,
        p.descripcion,
        c.nombre AS categoria,
        p.id_marca,
        m.nombre AS marca,
        p.presentacion,
        p.precio_compra,
        p.precio_venta,
        p.usa_variantes,
        p.configuracion_variantes,
        p.controla_lotes,
        p.controla_caducidad,
        p.activo,
        i.stock_actual,
        i.stock_minimo,
        i.ubicacion,

        CASE
          WHEN i.stock_actual <= i.stock_minimo THEN true
          ELSE false
        END AS bajo_stock,

        oc.id_oferta,
        oc.nombre AS oferta_nombre,
        oc.porcentaje_descuento,

        CASE
          WHEN oc.id_oferta IS NOT NULL THEN true
          ELSE false
        END AS tiene_oferta,

        CASE
          WHEN oc.id_oferta IS NOT NULL THEN
            ROUND(
              p.precio_venta -
              (p.precio_venta * oc.porcentaje_descuento / 100),
              2
            )
          ELSE p.precio_venta
        END AS precio_con_descuento,

        CASE
          WHEN oc.id_oferta IS NOT NULL THEN
            ROUND(
              p.precio_venta * oc.porcentaje_descuento / 100,
              2
            )
          ELSE 0
        END AS descuento_unitario,

        i.fecha_actualizacion,
        COALESCE(lotes.total_lotes, 0) AS total_lotes,
        lotes.proxima_caducidad,
        COALESCE(vars.total_variantes, 0) AS total_variantes,
        COALESCE(vars.variantes, '[]'::jsonb) AS variantes,

        CASE
          WHEN lotes.proxima_caducidad IS NULL THEN false
          WHEN lotes.proxima_caducidad <=
            CURRENT_DATE + INTERVAL '90 days' THEN true
          ELSE false
        END AS caducidad_proxima

      FROM inventario_sucursal i
      INNER JOIN sucursales s
        ON s.id_sucursal = i.id_sucursal
      INNER JOIN productos p
        ON p.id_producto = i.id_producto
      LEFT JOIN categorias c
        ON c.id_categoria = p.id_categoria
      LEFT JOIN marcas m
        ON m.id_marca = p.id_marca

      LEFT JOIN ofertas_categorias oc
        ON oc.id_categoria = p.id_categoria
       AND oc.activo = true
       AND CURRENT_DATE BETWEEN oc.fecha_inicio AND oc.fecha_fin

      LEFT JOIN (
        SELECT
          id_sucursal,
          id_producto,
          COUNT(*) AS total_lotes,
          MIN(fecha_caducidad) FILTER (
            WHERE stock_actual > 0
              AND activo = true
              AND fecha_caducidad IS NOT NULL
          ) AS proxima_caducidad
        FROM inventario_lotes
        GROUP BY id_sucursal, id_producto
      ) lotes
        ON lotes.id_sucursal = i.id_sucursal
       AND lotes.id_producto = i.id_producto

      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) AS total_variantes,
          jsonb_agg(
            jsonb_build_object(
              'id_inventario_variante', ivs.id_inventario_variante,
              'id_variante', pv.id_variante,
              'nombre_variante', pv.nombre_variante,
              'sku', pv.sku,
              'codigo_barras', pv.codigo_barras,
              'talla', pv.talla,
              'color', pv.color,
              'tono', pv.tono,
              'presentacion', pv.presentacion,
              'precio_compra', pv.precio_compra,
              'precio_venta', pv.precio_venta,
              'atributos', COALESCE(pv.atributos, '{}'::jsonb),
              'stock_actual', ivs.stock_actual,
              'stock_minimo', ivs.stock_minimo,
              'ubicacion', ivs.ubicacion,
              'activo', ivs.activo
            )
            ORDER BY pv.nombre_variante, pv.id_variante
          ) AS variantes
        FROM inventario_variantes_sucursal ivs
        INNER JOIN producto_variantes pv
          ON pv.id_variante = ivs.id_variante
        WHERE ivs.id_sucursal = i.id_sucursal
          AND ivs.id_producto = i.id_producto
          AND ivs.activo = true
          AND pv.activo = true
      ) vars ON true

      WHERE i.id_sucursal = $1
        AND p.activo = true
    `;

    const params = [sucursal];

    const idProducto = Number(id_producto);
    const tieneIdProducto =
      String(id_producto ?? '').trim() !== '' &&
      Number.isInteger(idProducto) &&
      idProducto > 0;

    if (String(id_producto ?? '').trim() !== '' && !tieneIdProducto) {
      return res.status(400).json({
        ok: false,
        mensaje: 'El parámetro id_producto no es válido',
      });
    }

    if (tieneIdProducto) {
      params.push(idProducto);
      query += ` AND i.id_producto = $${params.length} `;
    } else if (buscar && buscar.trim()) {
      params.push(`%${buscar.trim()}%`);

      query += `
        AND (
          p.nombre ILIKE $${params.length}
          OR p.codigo_barras ILIKE $${params.length}
          OR p.descripcion ILIKE $${params.length}
          OR m.nombre ILIKE $${params.length}
          OR p.presentacion ILIKE $${params.length}
          OR EXISTS (
            SELECT 1
            FROM inventario_variantes_sucursal ivb
            INNER JOIN producto_variantes pvb
              ON pvb.id_variante = ivb.id_variante
            WHERE ivb.id_sucursal = i.id_sucursal
              AND ivb.id_producto = i.id_producto
              AND (
                pvb.nombre_variante ILIKE $${params.length}
                OR pvb.sku ILIKE $${params.length}
                OR pvb.codigo_barras ILIKE $${params.length}
                OR pvb.talla ILIKE $${params.length}
                OR pvb.color ILIKE $${params.length}
                OR pvb.tono ILIKE $${params.length}
              )
          )
        )
      `;
    }

    query += ` ORDER BY p.nombre ASC `;

    if (
      String(autocomplete).trim() === '1' &&
      !tieneIdProducto
    ) {
      const limiteSolicitado = Number(limit);
      const limite = Number.isInteger(limiteSolicitado)
        ? Math.min(Math.max(limiteSolicitado, 1), 20)
        : 8;

      params.push(limite);
      query += ` LIMIT $${params.length} `;
    }

    const resultado = await pool.query(query, params);

    return res.json({
      ok: true,
      inventario: resultado.rows,
    });
  } catch (error) {
    console.error('Error al listar inventario:', error);

    return res.status(500).json({
      ok: false,
      mensaje: 'Error interno al listar inventario',
      error: error.message,
    });
  }
};

export const listarBajoStock = async (req, res) => {
  try {
    const { sucursal } = req.query;

    if (!sucursal) {
      return res.status(400).json({
        ok: false,
        mensaje: 'El parámetro sucursal es obligatorio',
      });
    }

    const resultado = await pool.query(
      `
        SELECT
          i.id_inventario,
          i.id_sucursal,
          s.nombre AS sucursal,
          i.id_producto,
          p.codigo_barras,
          p.nombre AS producto,
          c.nombre AS categoria,
          p.id_marca,
          m.nombre AS marca,
          p.presentacion,
          p.usa_variantes,
          p.configuracion_variantes,
          p.controla_lotes,
          p.controla_caducidad,
          i.stock_actual,
          i.stock_minimo,
          i.ubicacion,
          i.fecha_actualizacion,
          COALESCE(vars.total_variantes, 0) AS total_variantes
        FROM inventario_sucursal i
        INNER JOIN sucursales s
          ON s.id_sucursal = i.id_sucursal
        INNER JOIN productos p
          ON p.id_producto = i.id_producto
        LEFT JOIN categorias c
          ON c.id_categoria = p.id_categoria
        LEFT JOIN marcas m
          ON m.id_marca = p.id_marca
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS total_variantes
          FROM inventario_variantes_sucursal ivs
          WHERE ivs.id_sucursal = i.id_sucursal
            AND ivs.id_producto = i.id_producto
            AND ivs.activo = true
        ) vars ON true
        WHERE i.id_sucursal = $1
          AND i.stock_actual <= i.stock_minimo
        ORDER BY i.stock_actual ASC, p.nombre ASC
      `,
      [sucursal]
    );

    return res.json({
      ok: true,
      productos_bajo_stock: resultado.rows,
    });
  } catch (error) {
    console.error('Error al listar bajo stock:', error);

    return res.status(500).json({
      ok: false,
      mensaje: 'Error interno al listar productos con bajo stock',
      error: error.message,
    });
  }
};

export const asignarInventario = async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      id_sucursal,
      id_producto,
      id_proveedor,
      stock_inicial,
      stock_minimo,
      ubicacion,
      lote,
      fecha_caducidad,
      precio_compra,
      observaciones,
      variantes = [],
    } = req.body;

    const idSucursal = Number(id_sucursal);
    const idProducto = Number(id_producto);

    if (
      !Number.isInteger(idSucursal) ||
      idSucursal <= 0 ||
      !Number.isInteger(idProducto) ||
      idProducto <= 0
    ) {
      return res.status(400).json({
        ok: false,
        mensaje: 'La sucursal y el producto son obligatorios',
      });
    }

    await client.query('BEGIN');

    const productoResultado = await client.query(
      `
        SELECT
          id_producto,
          nombre,
          precio_compra,
          precio_venta,
          usa_variantes,
          configuracion_variantes,
          controla_lotes,
          controla_caducidad,
          activo
        FROM productos
        WHERE id_producto = $1
        LIMIT 1
        FOR SHARE
      `,
      [idProducto]
    );

    if (productoResultado.rows.length === 0) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        ok: false,
        mensaje: 'El producto no existe',
      });
    }

    const producto = productoResultado.rows[0];

    if (!producto.activo) {
      await client.query('ROLLBACK');

      return res.status(400).json({
        ok: false,
        mensaje: 'El producto está inactivo',
      });
    }

    const usaVariantes = normalizarBooleano(
      producto.usa_variantes,
      false
    );

    const controlaLotes = normalizarBooleano(
      producto.controla_lotes,
      false
    );

    const controlaCaducidad = normalizarBooleano(
      producto.controla_caducidad,
      false
    );

    const inventarioExistenteResultado = await client.query(
      `
        SELECT *
        FROM inventario_sucursal
        WHERE id_sucursal = $1
          AND id_producto = $2
        FOR UPDATE
      `,
      [idSucursal, idProducto]
    );

    const inventarioExistente =
      inventarioExistenteResultado.rows[0] || null;

    if (!usaVariantes && inventarioExistente) {
      await client.query('ROLLBACK');

      return res.status(409).json({
        ok: false,
        mensaje:
          'Ese producto ya tiene inventario asignado en esta sucursal',
      });
    }

    let cantidadTotalEntrada = 0;

    if (usaVariantes) {
      if (!Array.isArray(variantes) || variantes.length === 0) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          ok: false,
          mensaje:
            'El producto usa variantes. Debes enviar al menos una variante.',
        });
      }

      const clavesConfiguradas =
        obtenerClavesVariantesConfiguradas(
          producto.configuracion_variantes
        );

      if (clavesConfiguradas.length === 0) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          ok: false,
          mensaje:
            'El producto usa variantes pero no tiene configuracion_variantes definida.',
        });
      }

      for (const variante of variantes) {
        const cantidad = Number(variante?.stock_inicial ?? 0);

        if (!Number.isFinite(cantidad) || cantidad < 0) {
          await client.query('ROLLBACK');

          return res.status(400).json({
            ok: false,
            mensaje:
              'La cantidad inicial de cada variante debe ser igual o mayor a cero.',
          });
        }

        cantidadTotalEntrada += cantidad;
      }
    } else {
      cantidadTotalEntrada = Number(stock_inicial || 0);

      if (
        !Number.isFinite(cantidadTotalEntrada) ||
        cantidadTotalEntrada < 0
      ) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          ok: false,
          mensaje: 'El stock inicial no puede ser negativo',
        });
      }
    }

    if (
      controlaLotes &&
      cantidadTotalEntrada > 0 &&
      !normalizarTextoNullable(lote)
    ) {
      await client.query('ROLLBACK');

      return res.status(400).json({
        ok: false,
        mensaje:
          'Este producto controla lotes. El lote es obligatorio.',
      });
    }

    if (
      controlaCaducidad &&
      cantidadTotalEntrada > 0 &&
      !fecha_caducidad
    ) {
      await client.query('ROLLBACK');

      return res.status(400).json({
        ok: false,
        mensaje:
          'Este producto controla caducidad. La fecha de vencimiento es obligatoria.',
      });
    }

    const loteNormalizado = controlaLotes
      ? normalizarLote(lote)
      : 'SIN-LOTE';

    const fechaCaducidadNormalizada = controlaCaducidad
      ? fecha_caducidad || null
      : null;

    let inventario;

    if (inventarioExistente) {
      const stockNuevo =
        Number(inventarioExistente.stock_actual || 0) +
        cantidadTotalEntrada;

      const actualizado = await client.query(
        `
          UPDATE inventario_sucursal
          SET
            stock_actual = $1,
            stock_minimo = COALESCE($2, stock_minimo),
            ubicacion = COALESCE($3, ubicacion),
            fecha_actualizacion = CURRENT_TIMESTAMP
          WHERE id_inventario = $4
          RETURNING *
        `,
        [
          stockNuevo,
          stock_minimo === '' ||
          stock_minimo === undefined ||
          stock_minimo === null
            ? null
            : Number(stock_minimo),
          normalizarTextoNullable(ubicacion),
          inventarioExistente.id_inventario,
        ]
      );

      inventario = actualizado.rows[0];
    } else {
      const creado = await client.query(
        `
          INSERT INTO inventario_sucursal (
            id_sucursal,
            id_producto,
            stock_actual,
            stock_minimo,
            ubicacion
          )
          VALUES ($1,$2,$3,$4,$5)
          RETURNING *
        `,
        [
          idSucursal,
          idProducto,
          cantidadTotalEntrada,
          Number(stock_minimo || 0),
          normalizarTextoNullable(ubicacion),
        ]
      );

      inventario = creado.rows[0];
    }

    const stockGeneralAnterior = inventarioExistente
      ? Number(inventarioExistente.stock_actual || 0)
      : 0;

    let stockGeneralCursor = stockGeneralAnterior;
    const variantesGuardadas = [];
    const lotesCreados = [];

    if (usaVariantes) {
      for (const varianteEntrada of variantes) {
        const cantidad = Number(
          varianteEntrada?.stock_inicial || 0
        );

        const variante = await buscarOCrearVariante({
          client,
          producto,
          variante: varianteEntrada,
        });

        const stockVariante =
          await sumarStockVarianteSucursal({
            client,
            idSucursal,
            idProducto,
            idVariante: variante.id_variante,
            cantidad,
            ubicacion,
          });

        let loteGuardado = null;

        if (cantidad > 0) {
          loteGuardado = await sumarStockLote({
            client,
            idSucursal,
            idProducto,
            idVariante: variante.id_variante,
            idProveedor: id_proveedor || null,
            lote: loteNormalizado,
            fechaCaducidad: fechaCaducidadNormalizada,
            cantidad,
            precioCompra:
              precio_compra !== undefined &&
              precio_compra !== null &&
              precio_compra !== ''
                ? Number(precio_compra)
                : Number(variante.precio_compra || 0),
          });

          lotesCreados.push(loteGuardado);

          const stockAntesMovimiento = stockGeneralCursor;
          stockGeneralCursor += cantidad;

          await client.query(
            `
              INSERT INTO inventario_movimientos (
                id_sucursal,
                id_producto,
                id_variante,
                id_lote,
                id_proveedor,
                tipo_movimiento,
                cantidad,
                stock_anterior,
                stock_nuevo,
                referencia,
                observaciones,
                id_usuario
              )
              VALUES (
                $1,$2,$3,$4,$5,'STOCK_INICIAL',$6,$7,$8,$9,$10,$11
              )
            `,
            [
              idSucursal,
              idProducto,
              variante.id_variante,
              loteGuardado?.id_lote || null,
              id_proveedor || null,
              cantidad,
              stockAntesMovimiento,
              stockGeneralCursor,
              inventarioExistente
                ? 'ALTA_VARIANTE'
                : 'ASIGNACION_INICIAL',
              observaciones ||
                `Inventario inicial de ${variante.nombre_variante}`,
              req.usuario?.id_usuario || null,
            ]
          );
        }

        variantesGuardadas.push({
          ...variante,
          stock_sucursal: stockVariante.registro,
        });
      }
    } else {
      let loteCreado = null;

      if (cantidadTotalEntrada > 0) {
        loteCreado = await sumarStockLote({
          client,
          idSucursal,
          idProducto,
          idVariante: null,
          idProveedor: id_proveedor || null,
          lote: loteNormalizado,
          fechaCaducidad: fechaCaducidadNormalizada,
          cantidad: cantidadTotalEntrada,
          precioCompra: Number(precio_compra || 0),
        });

        lotesCreados.push(loteCreado);
      }

      await client.query(
        `
          INSERT INTO inventario_movimientos (
            id_sucursal,
            id_producto,
            id_variante,
            id_lote,
            id_proveedor,
            tipo_movimiento,
            cantidad,
            stock_anterior,
            stock_nuevo,
            referencia,
            observaciones,
            id_usuario
          )
          VALUES ($1,$2,NULL,$3,$4,'STOCK_INICIAL',$5,0,$5,$6,$7,$8)
        `,
        [
          idSucursal,
          idProducto,
          loteCreado?.id_lote || null,
          id_proveedor || null,
          cantidadTotalEntrada,
          'ASIGNACION_INICIAL',
          observaciones || 'Asignación inicial de inventario',
          req.usuario?.id_usuario || null,
        ]
      );
    }

    await client.query('COMMIT');

    return res.status(inventarioExistente ? 200 : 201).json({
      ok: true,
      mensaje: usaVariantes
        ? inventarioExistente
          ? 'Variantes agregadas al inventario correctamente'
          : 'Inventario con variantes asignado correctamente'
        : 'Inventario asignado correctamente',
      inventario,
      variantes: variantesGuardadas,
      lotes: lotesCreados,
    });
  } catch (error) {
    await client.query('ROLLBACK');

    console.error('Error al asignar inventario:', error);

    if (error.statusCode) {
      return res.status(error.statusCode).json({
        ok: false,
        mensaje: error.message,
      });
    }

    if (error.code === '23505') {
      return res.status(409).json({
        ok: false,
        mensaje:
          'Ya existe una variante con el mismo SKU, código de barras o combinación.',
        error: error.message,
      });
    }

    return res.status(500).json({
      ok: false,
      mensaje: 'Error interno al asignar inventario',
      error: error.message,
    });
  } finally {
    client.release();
  }
};

export const ajustarInventario = async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      id_sucursal,
      id_producto,
      id_variante,
      id_proveedor,
      id_lote,
      tipo_movimiento,
      cantidad,
      stock_minimo,
      ubicacion,
      lote,
      fecha_caducidad,
      precio_compra,
      referencia,
      observaciones,
    } = req.body;

    if (
      !id_sucursal ||
      !id_producto ||
      !tipo_movimiento ||
      cantidad === undefined
    ) {
      return res.status(400).json({
        ok: false,
        mensaje:
          'Sucursal, producto, tipo de movimiento y cantidad son obligatorios',
      });
    }

    const cantidadMovimiento = Number(cantidad);

    if (
      !Number.isFinite(cantidadMovimiento) ||
      cantidadMovimiento <= 0
    ) {
      return res.status(400).json({
        ok: false,
        mensaje: 'La cantidad debe ser mayor a cero',
      });
    }

    if (!tiposPermitidos.includes(tipo_movimiento)) {
      return res.status(400).json({
        ok: false,
        mensaje: 'Tipo de movimiento no válido',
        tipos_permitidos: tiposPermitidos,
      });
    }

    await client.query('BEGIN');

    const inventarioResultado = await client.query(
      `
        SELECT
          i.id_inventario,
          i.stock_actual,
          i.stock_minimo,
          i.ubicacion,
          p.usa_variantes,
          p.configuracion_variantes,
          p.controla_lotes,
          p.controla_caducidad
        FROM inventario_sucursal i
        INNER JOIN productos p
          ON p.id_producto = i.id_producto
        WHERE i.id_sucursal = $1
          AND i.id_producto = $2
        FOR UPDATE OF i
      `,
      [id_sucursal, id_producto]
    );

    if (inventarioResultado.rows.length === 0) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        ok: false,
        mensaje:
          'El producto no tiene inventario asignado en esta sucursal',
      });
    }

    const inventarioActual = inventarioResultado.rows[0];
    const usaVariantes = normalizarBooleano(
      inventarioActual.usa_variantes,
      false
    );
    const controlaLotes = normalizarBooleano(
      inventarioActual.controla_lotes,
      false
    );
    const controlaCaducidad = normalizarBooleano(
      inventarioActual.controla_caducidad,
      false
    );

    let varianteActual = null;
    const idVariante = id_variante ? Number(id_variante) : null;

    if (usaVariantes) {
      if (!Number.isInteger(idVariante) || idVariante <= 0) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          ok: false,
          mensaje:
            'Selecciona la variante que se modificará en el inventario',
        });
      }

      const varianteResultado = await client.query(
        `
          SELECT
            ivs.*,
            pv.nombre_variante,
            pv.sku,
            pv.codigo_barras
          FROM inventario_variantes_sucursal ivs
          INNER JOIN producto_variantes pv
            ON pv.id_variante = ivs.id_variante
          WHERE ivs.id_sucursal = $1
            AND ivs.id_producto = $2
            AND ivs.id_variante = $3
          FOR UPDATE OF ivs
        `,
        [id_sucursal, id_producto, idVariante]
      );

      if (varianteResultado.rows.length === 0) {
        await client.query('ROLLBACK');

        return res.status(404).json({
          ok: false,
          mensaje:
            'La variante no tiene inventario asignado en esta sucursal',
        });
      }

      varianteActual = varianteResultado.rows[0];
    }

    const stockAnterior = Number(
      inventarioActual.stock_actual || 0
    );

    const stockVarianteAnterior = varianteActual
      ? Number(varianteActual.stock_actual || 0)
      : null;

    const esEntrada = movimientosEntrada.includes(
      tipo_movimiento
    );
    const esSalida = movimientosSalida.includes(
      tipo_movimiento
    );

    let stockNuevo = stockAnterior;
    let stockVarianteNuevo = stockVarianteAnterior;

    if (esEntrada) {
      stockNuevo += cantidadMovimiento;

      if (varianteActual) {
        stockVarianteNuevo += cantidadMovimiento;
      }
    }

    if (esSalida) {
      stockNuevo -= cantidadMovimiento;

      if (stockNuevo < 0) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          ok: false,
          mensaje:
            'No hay stock suficiente para realizar este movimiento',
          stock_actual: stockAnterior,
          cantidad_solicitada: cantidadMovimiento,
        });
      }

      if (varianteActual) {
        stockVarianteNuevo -= cantidadMovimiento;

        if (stockVarianteNuevo < 0) {
          await client.query('ROLLBACK');

          return res.status(400).json({
            ok: false,
            mensaje:
              'La variante seleccionada no tiene stock suficiente',
            stock_variante: stockVarianteAnterior,
            cantidad_solicitada: cantidadMovimiento,
          });
        }
      }
    }

    let loteMovimientoId = id_lote || null;

    if (esEntrada) {
      if (id_lote) {
        const loteActualResultado = await client.query(
          `
            SELECT *
            FROM inventario_lotes
            WHERE id_lote = $1
              AND id_sucursal = $2
              AND id_producto = $3
              AND id_variante IS NOT DISTINCT FROM $4::integer
            FOR UPDATE
          `,
          [
            id_lote,
            id_sucursal,
            id_producto,
            usaVariantes ? idVariante : null,
          ]
        );

        if (loteActualResultado.rows.length === 0) {
          await client.query('ROLLBACK');

          return res.status(404).json({
            ok: false,
            mensaje:
              'El lote indicado no corresponde al producto/variante seleccionado',
          });
        }

        const loteActual = loteActualResultado.rows[0];

        const loteActualizado = await client.query(
          `
            UPDATE inventario_lotes
            SET
              stock_actual = stock_actual + $1,
              id_proveedor = COALESCE($2, id_proveedor),
              precio_compra = COALESCE($3, precio_compra),
              activo = true,
              fecha_actualizacion = CURRENT_TIMESTAMP
            WHERE id_lote = $4
            RETURNING *
          `,
          [
            cantidadMovimiento,
            id_proveedor || null,
            precio_compra !== undefined &&
            precio_compra !== null &&
            precio_compra !== ''
              ? Number(precio_compra)
              : null,
            loteActual.id_lote,
          ]
        );

        loteMovimientoId =
          loteActualizado.rows[0].id_lote;
      } else {
        if (
          controlaLotes &&
          !normalizarTextoNullable(lote)
        ) {
          await client.query('ROLLBACK');

          return res.status(400).json({
            ok: false,
            mensaje:
              'Este producto controla lotes. Captura el lote de entrada.',
          });
        }

        if (
          controlaCaducidad &&
          !fecha_caducidad
        ) {
          await client.query('ROLLBACK');

          return res.status(400).json({
            ok: false,
            mensaje:
              'Este producto controla caducidad. Captura la fecha de vencimiento.',
          });
        }

        const loteGuardado = await sumarStockLote({
          client,
          idSucursal: id_sucursal,
          idProducto: id_producto,
          idVariante: usaVariantes ? idVariante : null,
          idProveedor: id_proveedor || null,
          lote: controlaLotes
            ? normalizarLote(lote)
            : 'SIN-LOTE',
          fechaCaducidad: controlaCaducidad
            ? fecha_caducidad || null
            : null,
          cantidad: cantidadMovimiento,
          precioCompra:
            precio_compra !== undefined &&
            precio_compra !== null &&
            precio_compra !== ''
              ? Number(precio_compra)
              : 0,
        });

        loteMovimientoId = loteGuardado.id_lote;
      }
    }

    if (esSalida) {
      let cantidadPendiente = cantidadMovimiento;

      if (id_lote) {
        const loteActual = await client.query(
          `
            SELECT id_lote, stock_actual
            FROM inventario_lotes
            WHERE id_lote = $1
              AND id_sucursal = $2
              AND id_producto = $3
              AND id_variante IS NOT DISTINCT FROM $4::integer
            FOR UPDATE
          `,
          [
            id_lote,
            id_sucursal,
            id_producto,
            usaVariantes ? idVariante : null,
          ]
        );

        if (loteActual.rows.length === 0) {
          await client.query('ROLLBACK');

          return res.status(404).json({
            ok: false,
            mensaje:
              'El lote indicado no existe para este producto/variante',
          });
        }

        const stockLote = Number(
          loteActual.rows[0].stock_actual
        );

        if (stockLote < cantidadMovimiento) {
          await client.query('ROLLBACK');

          return res.status(400).json({
            ok: false,
            mensaje: 'El lote no tiene stock suficiente',
            stock_lote: stockLote,
            cantidad_solicitada: cantidadMovimiento,
          });
        }

        const nuevoStockLote =
          stockLote - cantidadMovimiento;

        await client.query(
          `
            UPDATE inventario_lotes
            SET
              stock_actual = $1,
              activo =
                CASE WHEN $1::numeric <= 0::numeric
                THEN false ELSE true END,
              fecha_actualizacion = CURRENT_TIMESTAMP
            WHERE id_lote = $2
          `,
          [nuevoStockLote, id_lote]
        );

        loteMovimientoId = id_lote;
      } else {
        const lotesDisponibles = await client.query(
          `
            SELECT id_lote, stock_actual
            FROM inventario_lotes
            WHERE id_sucursal = $1
              AND id_producto = $2
              AND id_variante IS NOT DISTINCT FROM $3::integer
              AND activo = true
              AND stock_actual > 0
            ORDER BY
              fecha_caducidad ASC NULLS LAST,
              fecha_entrada ASC,
              id_lote ASC
            FOR UPDATE
          `,
          [
            id_sucursal,
            id_producto,
            usaVariantes ? idVariante : null,
          ]
        );

        for (const loteItem of lotesDisponibles.rows) {
          if (cantidadPendiente <= 0) break;

          const stockLote = Number(
            loteItem.stock_actual
          );

          const cantidadADescontar = Math.min(
            stockLote,
            cantidadPendiente
          );

          const nuevoStockLote =
            stockLote - cantidadADescontar;

          await client.query(
            `
              UPDATE inventario_lotes
              SET
                stock_actual = $1,
                activo =
                  CASE WHEN $1::numeric <= 0::numeric
                  THEN false ELSE true END,
                fecha_actualizacion = CURRENT_TIMESTAMP
              WHERE id_lote = $2
            `,
            [nuevoStockLote, loteItem.id_lote]
          );

          cantidadPendiente -= cantidadADescontar;

          if (!loteMovimientoId) {
            loteMovimientoId = loteItem.id_lote;
          }
        }

        if (cantidadPendiente > 0) {
          await client.query('ROLLBACK');

          return res.status(400).json({
            ok: false,
            mensaje:
              'No hay stock suficiente por lotes para realizar este movimiento',
          });
        }
      }
    }

    if (varianteActual) {
      await client.query(
        `
          UPDATE inventario_variantes_sucursal
          SET
            stock_actual = $1,
            ubicacion = COALESCE($2, ubicacion),
            activo = true,
            fecha_actualizacion = CURRENT_TIMESTAMP
          WHERE id_inventario_variante = $3
        `,
        [
          stockVarianteNuevo,
          normalizarTextoNullable(ubicacion),
          varianteActual.id_inventario_variante,
        ]
      );
    }

    const inventarioActualizado = await client.query(
      `
        UPDATE inventario_sucursal
        SET
          stock_actual = $1,
          stock_minimo = COALESCE($2, stock_minimo),
          ubicacion = COALESCE($3, ubicacion),
          fecha_actualizacion = CURRENT_TIMESTAMP
        WHERE id_sucursal = $4
          AND id_producto = $5
        RETURNING *
      `,
      [
        stockNuevo,
        stock_minimo === undefined ||
        stock_minimo === null ||
        stock_minimo === ''
          ? null
          : Number(stock_minimo),
        normalizarTextoNullable(ubicacion),
        id_sucursal,
        id_producto,
      ]
    );

    const movimiento = await client.query(
      `
        INSERT INTO inventario_movimientos (
          id_sucursal,
          id_producto,
          id_variante,
          id_lote,
          id_proveedor,
          tipo_movimiento,
          cantidad,
          stock_anterior,
          stock_nuevo,
          referencia,
          observaciones,
          id_usuario
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
        )
        RETURNING *
      `,
      [
        id_sucursal,
        id_producto,
        usaVariantes ? idVariante : null,
        loteMovimientoId,
        id_proveedor || null,
        tipo_movimiento,
        cantidadMovimiento,
        stockAnterior,
        stockNuevo,
        referencia || null,
        observaciones || null,
        req.usuario?.id_usuario || null,
      ]
    );

    await client.query('COMMIT');

    return res.json({
      ok: true,
      mensaje: 'Inventario actualizado correctamente',
      inventario: inventarioActualizado.rows[0],
      movimiento: movimiento.rows[0],
      stock_variante: varianteActual
        ? stockVarianteNuevo
        : null,
    });
  } catch (error) {
    await client.query('ROLLBACK');

    console.error('Error al ajustar inventario:', error);

    return res.status(500).json({
      ok: false,
      mensaje: 'Error interno al ajustar inventario',
      error: error.message,
    });
  } finally {
    client.release();
  }
};

export const listarMovimientosInventario = async (req, res) => {
  try {
    const {
      sucursal,
      producto,
      tipo,
      fecha_inicio,
      fecha_fin,
    } = req.query;

    if (!sucursal) {
      return res.status(400).json({
        ok: false,
        mensaje: 'El parámetro sucursal es obligatorio',
      });
    }

    let query = `
      SELECT
        m.id_movimiento,
        m.id_sucursal,
        s.nombre AS sucursal,

        m.id_producto,
        p.nombre AS producto,
        p.codigo_barras,

        m.id_variante,
        pv.nombre_variante,
        pv.sku,
        pv.codigo_barras AS codigo_barras_variante,
        pv.talla,
        pv.color,
        pv.tono,
        pv.presentacion AS presentacion_variante,
        COALESCE(pv.atributos, '{}'::jsonb) AS atributos,

        m.id_lote,
        il.lote,
        il.fecha_caducidad,

        m.id_proveedor,
        prv.nombre AS proveedor,

        m.tipo_movimiento,
        m.cantidad,
        m.stock_anterior,
        m.stock_nuevo,
        m.referencia,
        m.observaciones,

        m.id_usuario,
        u.nombre AS usuario,

        m.fecha_movimiento
      FROM inventario_movimientos m
      INNER JOIN sucursales s
        ON s.id_sucursal = m.id_sucursal
      INNER JOIN productos p
        ON p.id_producto = m.id_producto
      LEFT JOIN producto_variantes pv
        ON pv.id_variante = m.id_variante
      LEFT JOIN usuarios u
        ON u.id_usuario = m.id_usuario
      LEFT JOIN inventario_lotes il
        ON il.id_lote = m.id_lote
      LEFT JOIN proveedores prv
        ON prv.id_proveedor = m.id_proveedor
      WHERE m.id_sucursal = $1
    `;

    const params = [sucursal];

    if (producto) {
      params.push(producto);
      query += ` AND m.id_producto = $${params.length} `;
    }

    if (tipo) {
      params.push(tipo);
      query += ` AND m.tipo_movimiento = $${params.length} `;
    }

    if (fecha_inicio) {
      params.push(fecha_inicio);
      query +=
        ` AND m.fecha_movimiento >= $${params.length}::date `;
    }

    if (fecha_fin) {
      params.push(fecha_fin);
      query +=
        ` AND m.fecha_movimiento < ` +
        `($${params.length}::date + INTERVAL '1 day') `;
    }

    query += ` ORDER BY m.fecha_movimiento DESC `;

    const resultado = await pool.query(query, params);

    return res.json({
      ok: true,
      movimientos: resultado.rows,
    });
  } catch (error) {
    console.error('Error al listar movimientos:', error);

    return res.status(500).json({
      ok: false,
      mensaje:
        'Error interno al listar movimientos de inventario',
      error: error.message,
    });
  }
};

export const listarLotesProducto = async (req, res) => {
  try {
    const { sucursal, producto } = req.query;

    if (!sucursal) {
      return res.status(400).json({
        ok: false,
        mensaje: 'El parámetro sucursal es obligatorio',
      });
    }

    let query = `
      SELECT
        il.id_lote,
        il.id_sucursal,
        s.nombre AS sucursal,
        i.ubicacion,
        il.id_producto,
        p.nombre AS producto,
        p.codigo_barras,

        il.id_variante,
        pv.nombre_variante,
        pv.sku,
        pv.codigo_barras AS codigo_barras_variante,
        pv.talla,
        pv.color,
        pv.tono,
        pv.presentacion AS presentacion_variante,
        COALESCE(pv.atributos, '{}'::jsonb) AS atributos,

        il.id_proveedor,
        prv.nombre AS proveedor,

        il.id_compra,
        co.folio AS folio_compra,
        il.id_compra_detalle,

        il.lote,
        il.fecha_caducidad,
        il.stock_actual,
        il.precio_compra,
        il.activo,
        il.fecha_entrada,
        il.fecha_actualizacion,

        CASE
          WHEN il.fecha_caducidad IS NULL THEN false
          WHEN il.fecha_caducidad <=
            CURRENT_DATE + INTERVAL '90 days' THEN true
          ELSE false
        END AS caducidad_proxima,

        CASE
          WHEN il.fecha_caducidad IS NULL THEN false
          WHEN il.fecha_caducidad < CURRENT_DATE THEN true
          ELSE false
        END AS caducado
      FROM inventario_lotes il
      INNER JOIN sucursales s
        ON s.id_sucursal = il.id_sucursal
      INNER JOIN productos p
        ON p.id_producto = il.id_producto
      LEFT JOIN producto_variantes pv
        ON pv.id_variante = il.id_variante
      LEFT JOIN inventario_sucursal i
        ON i.id_sucursal = il.id_sucursal
       AND i.id_producto = il.id_producto
      LEFT JOIN proveedores prv
        ON prv.id_proveedor = il.id_proveedor
      LEFT JOIN compras co
        ON co.id_compra = il.id_compra
      WHERE il.id_sucursal = $1
    `;

    const params = [sucursal];

    if (producto) {
      params.push(producto);
      query += ` AND il.id_producto = $${params.length} `;
    }

    query += `
      ORDER BY
        pv.nombre_variante ASC NULLS FIRST,
        il.fecha_caducidad ASC NULLS LAST,
        il.fecha_entrada ASC
    `;

    const resultado = await pool.query(query, params);

    return res.json({
      ok: true,
      lotes: resultado.rows,
    });
  } catch (error) {
    console.error('Error al listar lotes:', error);

    return res.status(500).json({
      ok: false,
      mensaje: 'Error interno al listar lotes',
      error: error.message,
    });
  }
};

export const actualizarLote = async (req, res) => {
  const client = await pool.connect();

  try {
    const { id_lote } = req.params;

    const {
      id_proveedor,
      lote,
      fecha_caducidad,
      precio_compra,
      stock_actual,
      ubicacion,
      observaciones,
    } = req.body;

    if (!id_lote) {
      return res.status(400).json({
        ok: false,
        mensaje: 'El ID del lote es obligatorio',
      });
    }

    if (!lote || !String(lote).trim()) {
      return res.status(400).json({
        ok: false,
        mensaje: 'El lote es obligatorio',
      });
    }

    if (
      precio_compra !== undefined &&
      precio_compra !== null &&
      precio_compra !== '' &&
      (!Number.isFinite(Number(precio_compra)) ||
        Number(precio_compra) < 0)
    ) {
      return res.status(400).json({
        ok: false,
        mensaje: 'El precio de compra no puede ser negativo',
      });
    }

    const seEnvioStock = Object.prototype.hasOwnProperty.call(
      req.body,
      'stock_actual'
    );

    if (
      seEnvioStock &&
      (
        stock_actual === '' ||
        stock_actual === null ||
        !Number.isFinite(Number(stock_actual)) ||
        Number(stock_actual) < 0
      )
    ) {
      return res.status(400).json({
        ok: false,
        mensaje:
          'El stock del lote debe ser un número igual o mayor a cero',
      });
    }

    await client.query('BEGIN');

    const loteActualResultado = await client.query(
      `
        SELECT
          id_lote,
          id_sucursal,
          id_producto,
          id_variante,
          id_proveedor,
          lote,
          fecha_caducidad,
          stock_actual,
          precio_compra,
          activo
        FROM inventario_lotes
        WHERE id_lote = $1
        FOR UPDATE
      `,
      [id_lote]
    );

    if (loteActualResultado.rows.length === 0) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        ok: false,
        mensaje: 'El lote no existe',
      });
    }

    const loteActual = loteActualResultado.rows[0];

    const inventarioActualResultado = await client.query(
      `
        SELECT
          id_inventario,
          stock_actual,
          ubicacion
        FROM inventario_sucursal
        WHERE id_sucursal = $1
          AND id_producto = $2
        FOR UPDATE
      `,
      [loteActual.id_sucursal, loteActual.id_producto]
    );

    if (inventarioActualResultado.rows.length === 0) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        ok: false,
        mensaje:
          'No se encontró el inventario general asociado al lote',
      });
    }

    let inventarioVarianteActual = null;

    if (loteActual.id_variante) {
      const varianteResultado = await client.query(
        `
          SELECT *
          FROM inventario_variantes_sucursal
          WHERE id_sucursal = $1
            AND id_producto = $2
            AND id_variante = $3
          FOR UPDATE
        `,
        [
          loteActual.id_sucursal,
          loteActual.id_producto,
          loteActual.id_variante,
        ]
      );

      if (varianteResultado.rows.length === 0) {
        await client.query('ROLLBACK');

        return res.status(404).json({
          ok: false,
          mensaje:
            'No se encontró el inventario de la variante asociada al lote',
        });
      }

      inventarioVarianteActual =
        varianteResultado.rows[0];
    }

    const inventarioActual =
      inventarioActualResultado.rows[0];

    const loteNormalizado = normalizarLote(lote);

    const loteDuplicado = await client.query(
      `
        SELECT id_lote
        FROM inventario_lotes
        WHERE id_sucursal = $1
          AND id_producto = $2
          AND id_variante IS NOT DISTINCT FROM $3::integer
          AND lote = $4
          AND fecha_caducidad IS NOT DISTINCT FROM $5::date
          AND id_lote <> $6
        LIMIT 1
      `,
      [
        loteActual.id_sucursal,
        loteActual.id_producto,
        loteActual.id_variante,
        loteNormalizado,
        fecha_caducidad || null,
        id_lote,
      ]
    );

    if (loteDuplicado.rows.length > 0) {
      await client.query('ROLLBACK');

      return res.status(409).json({
        ok: false,
        mensaje:
          'Ya existe otro lote con el mismo número, variante y fecha de caducidad',
      });
    }

    const stockAnteriorLote = Number(
      loteActual.stock_actual || 0
    );

    const stockNuevoLote = seEnvioStock
      ? Number(stock_actual)
      : stockAnteriorLote;

    const diferenciaStock =
      stockNuevoLote - stockAnteriorLote;

    const stockAnteriorInventario = Number(
      inventarioActual.stock_actual || 0
    );

    const stockNuevoInventario =
      stockAnteriorInventario + diferenciaStock;

    if (stockNuevoInventario < 0) {
      await client.query('ROLLBACK');

      return res.status(400).json({
        ok: false,
        mensaje:
          'El ajuste dejaría el inventario general en un valor negativo.',
      });
    }

    let stockNuevoVariante = null;

    if (inventarioVarianteActual) {
      stockNuevoVariante =
        Number(inventarioVarianteActual.stock_actual || 0) +
        diferenciaStock;

      if (stockNuevoVariante < 0) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          ok: false,
          mensaje:
            'El ajuste dejaría la variante con stock negativo.',
        });
      }
    }

    const ubicacionActualizada =
      Object.prototype.hasOwnProperty.call(
        req.body,
        'ubicacion'
      )
        ? normalizarTextoNullable(ubicacion)
        : inventarioActual.ubicacion;

    const proveedorActualizado = id_proveedor
      ? Number(id_proveedor)
      : null;

    const precioCompraActualizado =
      precio_compra !== '' &&
      precio_compra !== null &&
      precio_compra !== undefined
        ? Number(precio_compra)
        : 0;

    const loteActualizadoResultado =
      await client.query(
        `
          UPDATE inventario_lotes
          SET
            id_proveedor = $1,
            lote = $2,
            fecha_caducidad = $3,
            precio_compra = $4,
            stock_actual = $5,
            activo =
              CASE WHEN $5::numeric > 0
              THEN true ELSE false END,
            fecha_actualizacion = CURRENT_TIMESTAMP
          WHERE id_lote = $6
          RETURNING *
        `,
        [
          proveedorActualizado,
          loteNormalizado,
          fecha_caducidad || null,
          precioCompraActualizado,
          stockNuevoLote,
          id_lote,
        ]
      );

    const inventarioActualizadoResultado =
      await client.query(
        `
          UPDATE inventario_sucursal
          SET
            stock_actual = $1,
            ubicacion = $2,
            fecha_actualizacion = CURRENT_TIMESTAMP
          WHERE id_sucursal = $3
            AND id_producto = $4
          RETURNING *
        `,
        [
          stockNuevoInventario,
          ubicacionActualizada,
          loteActual.id_sucursal,
          loteActual.id_producto,
        ]
      );

    if (inventarioVarianteActual) {
      await client.query(
        `
          UPDATE inventario_variantes_sucursal
          SET
            stock_actual = $1,
            ubicacion = COALESCE($2, ubicacion),
            activo = true,
            fecha_actualizacion = CURRENT_TIMESTAMP
          WHERE id_inventario_variante = $3
        `,
        [
          stockNuevoVariante,
          ubicacionActualizada,
          inventarioVarianteActual.id_inventario_variante,
        ]
      );
    }

    if (diferenciaStock !== 0) {
      const tipoMovimiento =
        diferenciaStock > 0
          ? 'AJUSTE_POSITIVO'
          : 'AJUSTE_NEGATIVO';

      const observacionMovimiento = [
        `Edición manual del lote ${loteNormalizado}.`,
        `Stock del lote: ${stockAnteriorLote} → ${stockNuevoLote}.`,
        observaciones
          ? `Motivo: ${String(observaciones).trim()}`
          : '',
      ]
        .filter(Boolean)
        .join(' ');

      await client.query(
        `
          INSERT INTO inventario_movimientos (
            id_sucursal,
            id_producto,
            id_variante,
            id_lote,
            id_proveedor,
            tipo_movimiento,
            cantidad,
            stock_anterior,
            stock_nuevo,
            referencia,
            observaciones,
            id_usuario
          )
          VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
          )
        `,
        [
          loteActual.id_sucursal,
          loteActual.id_producto,
          loteActual.id_variante || null,
          Number(id_lote),
          proveedorActualizado,
          tipoMovimiento,
          Math.abs(diferenciaStock),
          stockAnteriorInventario,
          stockNuevoInventario,
          'EDICION_LOTE',
          observacionMovimiento,
          req.usuario?.id_usuario || null,
        ]
      );
    }

    await client.query('COMMIT');

    return res.json({
      ok: true,
      mensaje:
        diferenciaStock !== 0
          ? 'Lote actualizado y ajuste de inventario registrado correctamente'
          : 'Lote actualizado correctamente',
      lote: loteActualizadoResultado.rows[0],
      inventario:
        inventarioActualizadoResultado.rows[0],
      diferencia_stock: diferenciaStock,
      stock_variante: stockNuevoVariante,
    });
  } catch (error) {
    await client.query('ROLLBACK');

    console.error('Error al actualizar lote:', error);

    return res.status(500).json({
      ok: false,
      mensaje: 'Error interno al actualizar el lote',
      error: error.message,
    });
  } finally {
    client.release();
  }
};

export const listarCaducidadProxima = async (req, res) => {
  try {
    const { sucursal, dias = 90 } = req.query;

    if (!sucursal) {
      return res.status(400).json({
        ok: false,
        mensaje: 'El parámetro sucursal es obligatorio',
      });
    }

    const resultado = await pool.query(
      `
        SELECT
          il.id_lote,
          il.id_sucursal,
          s.nombre AS sucursal,
          il.id_producto,
          p.nombre AS producto,
          p.codigo_barras,

          il.id_variante,
          pv.nombre_variante,
          pv.sku,
          pv.codigo_barras AS codigo_barras_variante,
          pv.talla,
          pv.color,
          pv.tono,
          pv.presentacion AS presentacion_variante,
          COALESCE(pv.atributos, '{}'::jsonb) AS atributos,

          il.lote,
          il.fecha_caducidad,
          il.stock_actual,
          il.precio_compra,
          il.activo,
          il.fecha_entrada,

          CASE
            WHEN il.fecha_caducidad < CURRENT_DATE
              THEN 'CADUCADO'
            ELSE 'POR_CADUCAR'
          END AS estado_caducidad
        FROM inventario_lotes il
        INNER JOIN sucursales s
          ON s.id_sucursal = il.id_sucursal
        INNER JOIN productos p
          ON p.id_producto = il.id_producto
        LEFT JOIN producto_variantes pv
          ON pv.id_variante = il.id_variante
        WHERE il.id_sucursal = $1
          AND il.stock_actual > 0
          AND il.fecha_caducidad IS NOT NULL
          AND il.fecha_caducidad <=
            CURRENT_DATE + ($2 || ' days')::INTERVAL
        ORDER BY il.fecha_caducidad ASC
      `,
      [sucursal, dias]
    );

    return res.json({
      ok: true,
      dias: Number(dias),
      productos_caducidad: resultado.rows,
    });
  } catch (error) {
    console.error(
      'Error al listar caducidad próxima:',
      error
    );

    return res.status(500).json({
      ok: false,
      mensaje:
        'Error interno al listar productos por caducar',
      error: error.message,
    });
  }
};

export const bajaLotePorCaducidad = async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      id_sucursal,
      id_producto,
      id_lote,
      observaciones,
    } = req.body;

    if (!id_sucursal || !id_producto || !id_lote) {
      return res.status(400).json({
        ok: false,
        mensaje: 'Sucursal, producto y lote son obligatorios',
      });
    }

    await client.query('BEGIN');

    const loteResultado = await client.query(
      `
        SELECT
          id_lote,
          id_sucursal,
          id_producto,
          id_variante,
          lote,
          fecha_caducidad,
          stock_actual,
          activo
        FROM inventario_lotes
        WHERE id_lote = $1
          AND id_sucursal = $2
          AND id_producto = $3
        FOR UPDATE
      `,
      [id_lote, id_sucursal, id_producto]
    );

    if (loteResultado.rows.length === 0) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        ok: false,
        mensaje:
          'El lote no existe para esta sucursal y producto',
      });
    }

    const loteActual = loteResultado.rows[0];
    const stockLote = Number(
      loteActual.stock_actual || 0
    );

    if (stockLote <= 0) {
      await client.query('ROLLBACK');

      return res.status(400).json({
        ok: false,
        mensaje:
          'El lote no tiene stock disponible para dar de baja',
      });
    }

    const inventarioResultado = await client.query(
      `
        SELECT
          id_inventario,
          stock_actual
        FROM inventario_sucursal
        WHERE id_sucursal = $1
          AND id_producto = $2
        FOR UPDATE
      `,
      [id_sucursal, id_producto]
    );

    if (inventarioResultado.rows.length === 0) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        ok: false,
        mensaje:
          'No existe inventario general para este producto en la sucursal',
      });
    }

    const stockAnterior = Number(
      inventarioResultado.rows[0].stock_actual || 0
    );

    const stockNuevo = Math.max(
      stockAnterior - stockLote,
      0
    );

    let stockVarianteNuevo = null;

    if (loteActual.id_variante) {
      const varianteResultado = await client.query(
        `
          SELECT *
          FROM inventario_variantes_sucursal
          WHERE id_sucursal = $1
            AND id_producto = $2
            AND id_variante = $3
          FOR UPDATE
        `,
        [
          id_sucursal,
          id_producto,
          loteActual.id_variante,
        ]
      );

      if (varianteResultado.rows.length === 0) {
        await client.query('ROLLBACK');

        return res.status(404).json({
          ok: false,
          mensaje:
            'No existe inventario para la variante asociada al lote',
        });
      }

      const stockVarianteAnterior = Number(
        varianteResultado.rows[0].stock_actual || 0
      );

      stockVarianteNuevo = Math.max(
        stockVarianteAnterior - stockLote,
        0
      );

      await client.query(
        `
          UPDATE inventario_variantes_sucursal
          SET
            stock_actual = $1,
            activo = true,
            fecha_actualizacion = CURRENT_TIMESTAMP
          WHERE id_inventario_variante = $2
        `,
        [
          stockVarianteNuevo,
          varianteResultado.rows[0]
            .id_inventario_variante,
        ]
      );
    }

    await client.query(
      `
        UPDATE inventario_lotes
        SET
          stock_actual = 0,
          activo = false,
          fecha_actualizacion = CURRENT_TIMESTAMP
        WHERE id_lote = $1
      `,
      [id_lote]
    );

    const inventarioActualizado = await client.query(
      `
        UPDATE inventario_sucursal
        SET
          stock_actual = $1,
          fecha_actualizacion = CURRENT_TIMESTAMP
        WHERE id_sucursal = $2
          AND id_producto = $3
        RETURNING *
      `,
      [stockNuevo, id_sucursal, id_producto]
    );

    const movimiento = await client.query(
      `
        INSERT INTO inventario_movimientos (
          id_sucursal,
          id_producto,
          id_variante,
          id_lote,
          tipo_movimiento,
          cantidad,
          stock_anterior,
          stock_nuevo,
          referencia,
          observaciones,
          id_usuario
        )
        VALUES (
          $1,$2,$3,$4,'CADUCIDAD',$5,$6,$7,$8,$9,$10
        )
        RETURNING *
      `,
      [
        id_sucursal,
        id_producto,
        loteActual.id_variante || null,
        id_lote,
        stockLote,
        stockAnterior,
        stockNuevo,
        `CADUCIDAD-${loteActual.lote}`,
        observaciones ||
          `Baja por caducidad del lote ${loteActual.lote}`,
        req.usuario?.id_usuario || null,
      ]
    );

    await client.query('COMMIT');

    return res.json({
      ok: true,
      mensaje:
        'Lote dado de baja por caducidad correctamente',
      lote: {
        ...loteActual,
        stock_baja: stockLote,
      },
      inventario: inventarioActualizado.rows[0],
      movimiento: movimiento.rows[0],
      stock_variante: stockVarianteNuevo,
    });
  } catch (error) {
    await client.query('ROLLBACK');

    console.error(
      'Error al dar de baja lote por caducidad:',
      error
    );

    return res.status(500).json({
      ok: false,
      mensaje:
        'Error interno al dar de baja lote por caducidad',
      error: error.message,
    });
  } finally {
    client.release();
  }
};

export const consultarStockSucursales = async (req, res) => {
  try {
    const {
      buscar = '',
      busqueda = '',
      nombre = '',
      codigo_barras = '',
      codigo = '',
      presentacion = '',
      id_producto = '',
      modo = '',
    } = req.query;

    const textoBusqueda = String(
      buscar ||
      busqueda ||
      nombre ||
      codigo_barras ||
      codigo ||
      presentacion ||
      ''
    ).trim();

    const esBusquedaSugerencias =
      modo === 'sugerencias';

    const selectProductoBase = `
      SELECT
        p.id_producto,
        p.codigo_barras,
        p.nombre,
        p.descripcion,
        p.id_marca,
        m.nombre AS marca,
        p.presentacion,
        c.nombre AS categoria,
        p.precio_venta,
        p.usa_variantes,
        p.configuracion_variantes,
        p.controla_lotes,
        p.controla_caducidad
      FROM productos p
      LEFT JOIN categorias c
        ON c.id_categoria = p.id_categoria
      LEFT JOIN marcas m
        ON m.id_marca = p.id_marca
    `;

    if (esBusquedaSugerencias) {
      if (textoBusqueda.length < 2) {
        return res.json({
          ok: true,
          productos: [],
        });
      }

      const texto = `%${textoBusqueda}%`;

      const sugerenciasResultado = await pool.query(
        `
          ${selectProductoBase}
          WHERE p.activo = true
            AND (
              p.nombre ILIKE $1
              OR p.codigo_barras ILIKE $1
              OR p.descripcion ILIKE $1
              OR m.nombre ILIKE $1
              OR p.presentacion ILIKE $1
              OR EXISTS (
                SELECT 1
                FROM producto_variantes pv
                WHERE pv.id_producto = p.id_producto
                  AND pv.activo = true
                  AND (
                    pv.nombre_variante ILIKE $1
                    OR pv.sku ILIKE $1
                    OR pv.codigo_barras ILIKE $1
                    OR pv.talla ILIKE $1
                    OR pv.color ILIKE $1
                    OR pv.tono ILIKE $1
                  )
              )
            )
          ORDER BY
            CASE
              WHEN p.codigo_barras = $2 THEN 0
              WHEN LOWER(p.nombre) = LOWER($2) THEN 1
              WHEN p.nombre ILIKE $1 THEN 2
              ELSE 3
            END,
            p.nombre ASC
          LIMIT 10
        `,
        [texto, textoBusqueda]
      );

      return res.json({
        ok: true,
        productos: sugerenciasResultado.rows,
      });
    }

    let productoResultado;

    if (id_producto !== '') {
      const idProducto = Number(id_producto);

      if (!Number.isInteger(idProducto) || idProducto <= 0) {
        return res.status(400).json({
          ok: false,
          mensaje: 'El id_producto no es válido',
        });
      }

      productoResultado = await pool.query(
        `
          ${selectProductoBase}
          WHERE p.activo = true
            AND p.id_producto = $1
          LIMIT 1
        `,
        [idProducto]
      );
    } else {
      if (!textoBusqueda) {
        return res.status(400).json({
          ok: false,
          mensaje:
            'Debes escribir el nombre, código de barras o presentación del producto',
        });
      }

      const texto = `%${textoBusqueda}%`;

      productoResultado = await pool.query(
        `
          ${selectProductoBase}
          WHERE p.activo = true
            AND (
              p.nombre ILIKE $1
              OR p.codigo_barras ILIKE $1
              OR p.descripcion ILIKE $1
              OR m.nombre ILIKE $1
              OR p.presentacion ILIKE $1
              OR EXISTS (
                SELECT 1
                FROM producto_variantes pv
                WHERE pv.id_producto = p.id_producto
                  AND pv.activo = true
                  AND (
                    pv.nombre_variante ILIKE $1
                    OR pv.sku ILIKE $1
                    OR pv.codigo_barras ILIKE $1
                    OR pv.talla ILIKE $1
                    OR pv.color ILIKE $1
                    OR pv.tono ILIKE $1
                  )
              )
            )
          ORDER BY
            CASE
              WHEN p.codigo_barras = $2 THEN 0
              WHEN LOWER(p.nombre) = LOWER($2) THEN 1
              WHEN p.nombre ILIKE $1 THEN 2
              ELSE 3
            END,
            p.nombre ASC
          LIMIT 1
        `,
        [texto, textoBusqueda]
      );
    }

    if (productoResultado.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        mensaje:
          'No se encontró ningún producto con esa búsqueda.',
      });
    }

    const producto = productoResultado.rows[0];

    const sucursalesResultado = await pool.query(
      `
        SELECT
          s.id_sucursal,
          s.nombre AS sucursal,
          s.direccion,
          COALESCE(i.stock_actual, 0) AS stock,
          COALESCE(i.stock_minimo, 0) AS stock_minimo,
          i.ubicacion,
          i.fecha_actualizacion,

          COALESCE(
            (
              SELECT jsonb_agg(
                jsonb_build_object(
                  'id_variante', pv.id_variante,
                  'nombre_variante', pv.nombre_variante,
                  'sku', pv.sku,
                  'codigo_barras', pv.codigo_barras,
                  'talla', pv.talla,
                  'color', pv.color,
                  'tono', pv.tono,
                  'presentacion', pv.presentacion,
                  'atributos', COALESCE(pv.atributos, '{}'::jsonb),
                  'stock_actual', ivs.stock_actual,
                  'stock_minimo', ivs.stock_minimo,
                  'ubicacion', ivs.ubicacion
                )
                ORDER BY pv.nombre_variante, pv.id_variante
              )
              FROM inventario_variantes_sucursal ivs
              INNER JOIN producto_variantes pv
                ON pv.id_variante = ivs.id_variante
              WHERE ivs.id_sucursal = s.id_sucursal
                AND ivs.id_producto = $1
                AND ivs.activo = true
                AND pv.activo = true
            ),
            '[]'::jsonb
          ) AS variantes,

          CASE
            WHEN COALESCE(i.stock_actual, 0) <= 0
              THEN 'SIN_STOCK'
            WHEN COALESCE(i.stock_actual, 0) <=
              COALESCE(i.stock_minimo, 0)
              THEN 'STOCK_BAJO'
            ELSE 'DISPONIBLE'
          END AS estado
        FROM sucursales s
        LEFT JOIN inventario_sucursal i
          ON i.id_sucursal = s.id_sucursal
         AND i.id_producto = $1
        WHERE s.activo = true
        ORDER BY
          COALESCE(i.stock_actual, 0) DESC,
          s.nombre ASC
      `,
      [producto.id_producto]
    );

    const sucursales = sucursalesResultado.rows;

    const productos = sucursales.map((sucursal) => ({
      id_producto: producto.id_producto,
      codigo_barras: producto.codigo_barras,
      nombre_producto: producto.nombre,
      nombre: producto.nombre,
      descripcion: producto.descripcion,
      id_marca: producto.id_marca,
      marca: producto.marca,
      presentacion: producto.presentacion,
      categoria: producto.categoria,
      precio_venta: producto.precio_venta,
      usa_variantes: producto.usa_variantes,
      configuracion_variantes:
        producto.configuracion_variantes,
      controla_lotes: producto.controla_lotes,
      controla_caducidad: producto.controla_caducidad,

      id_sucursal: sucursal.id_sucursal,
      nombre_sucursal: sucursal.sucursal,
      sucursal: sucursal.sucursal,
      direccion_sucursal: sucursal.direccion,

      stock_disponible: Number(sucursal.stock || 0),
      stock: Number(sucursal.stock || 0),
      stock_minimo: Number(sucursal.stock_minimo || 0),
      ubicacion: sucursal.ubicacion,
      estado: sucursal.estado,
      fecha_actualizacion: sucursal.fecha_actualizacion,
      variantes: sucursal.variantes || [],

      lote: null,
      fecha_caducidad: null,
    }));

    return res.json({
      ok: true,
      producto: {
        id_producto: producto.id_producto,
        nombre: producto.nombre,
        descripcion: producto.descripcion,
        codigo_barras: producto.codigo_barras,
        id_marca: producto.id_marca,
        marca: producto.marca,
        presentacion: producto.presentacion,
        categoria: producto.categoria,
        precio_venta: producto.precio_venta,
        usa_variantes: producto.usa_variantes,
        configuracion_variantes:
          producto.configuracion_variantes,
        controla_lotes: producto.controla_lotes,
        controla_caducidad: producto.controla_caducidad,
      },
      sucursales,
      productos,
    });
  } catch (error) {
    console.error(
      'Error al consultar stock en sucursales:',
      error
    );

    return res.status(500).json({
      ok: false,
      mensaje:
        'Error interno al consultar stock en sucursales',
      error: error.message,
    });
  }
};

