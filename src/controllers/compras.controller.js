import { pool } from '../config/db.js';

const generarFolioCompra = () => {
  const fecha = new Date();
  const yyyy = fecha.getFullYear();
  const mm = String(fecha.getMonth() + 1).padStart(2, '0');
  const dd = String(fecha.getDate()).padStart(2, '0');
  const hh = String(fecha.getHours()).padStart(2, '0');
  const mi = String(fecha.getMinutes()).padStart(2, '0');
  const ss = String(fecha.getSeconds()).padStart(2, '0');
  const random = Math.floor(Math.random() * 9000) + 1000;

  return `C-${yyyy}${mm}${dd}-${hh}${mi}${ss}-${random}`;
};

const normalizarBooleano = (valor) => {
  if (typeof valor === 'boolean') return valor;
  const texto = String(valor ?? '').trim().toLowerCase();
  return ['true', '1', 't', 'si', 'sí', 's', 'yes'].includes(texto);
};

const normalizarLote = (lote) => {
  const valor = String(lote ?? '').trim().toUpperCase();
  return valor || null;
};

const normalizarTextoNullable = (valor) => {
  const texto = String(valor ?? '').trim();
  return texto || null;
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
  ].filter((clave) => normalizarBooleano(config[clave]));

  const personalizados = (config.personalizados || []).map(
    (item) => item.clave
  );

  return [...base, ...personalizados];
};

const normalizarAtributosVarianteCompra = (variante, configuracion) => {
  const claves = obtenerClavesVariantesConfiguradas(configuracion);
  const origen = parsearAtributos(variante?.atributos);
  const atributos = {};

  for (const clave of claves) {
    const valor = normalizarTextoNullable(
      variante?.[clave] ?? origen?.[clave]
    );

    if (!valor) {
      throw crearErrorHttp(
        400,
        `Falta capturar el atributo "${clave}" de la variante`
      );
    }

    atributos[clave] = valor;
  }

  return atributos;
};

const obtenerNombreVarianteCompra = (variante, atributos, configuracion) => {
  const nombreManual = normalizarTextoNullable(variante?.nombre_variante);
  if (nombreManual) return nombreManual;

  return (
    obtenerClavesVariantesConfiguradas(configuracion)
      .map((clave) => atributos?.[clave])
      .filter(Boolean)
      .join(' · ') || 'Variante'
  );
};

const buscarOCrearVarianteCompra = async ({
  client,
  producto,
  varianteEntrada,
  precioCompra,
}) => {
  const configuracion = normalizarConfiguracionVariantes(
    producto.configuracion_variantes
  );

  if (obtenerClavesVariantesConfiguradas(configuracion).length === 0) {
    throw crearErrorHttp(
      400,
      `El producto ${producto.nombre} tiene activadas las variantes, pero no tiene atributos configurados`
    );
  }

  const atributos = normalizarAtributosVarianteCompra(
    varianteEntrada,
    configuracion
  );

  const talla = normalizarTextoNullable(atributos.talla);
  const color = normalizarTextoNullable(atributos.color);
  const tono = normalizarTextoNullable(atributos.tono);
  const presentacion = normalizarTextoNullable(atributos.presentacion);
  const sku = normalizarTextoNullable(varianteEntrada?.sku);
  const codigoBarras = normalizarTextoNullable(
    varianteEntrada?.codigo_barras
  );
  const nombreVariante = obtenerNombreVarianteCompra(
    varianteEntrada,
    atributos,
    configuracion
  );

  // SKU y código son opcionales, pero cuando vienen capturados no deben
  // identificar otra variante distinta.
  if (sku) {
    const skuExistente = await client.query(
      `
        SELECT id_variante, id_producto
        FROM producto_variantes
        WHERE LOWER(COALESCE(sku, '')) = LOWER($1)
        LIMIT 1
      `,
      [sku]
    );

    if (
      skuExistente.rows.length > 0 &&
      Number(skuExistente.rows[0].id_producto) !== Number(producto.id_producto)
    ) {
      throw crearErrorHttp(409, `El SKU ${sku} ya pertenece a otro producto`);
    }
  }

  if (codigoBarras) {
    const codigoExistente = await client.query(
      `
        SELECT id_variante, id_producto
        FROM producto_variantes
        WHERE codigo_barras = $1
        LIMIT 1
      `,
      [codigoBarras]
    );

    if (
      codigoExistente.rows.length > 0 &&
      Number(codigoExistente.rows[0].id_producto) !== Number(producto.id_producto)
    ) {
      throw crearErrorHttp(
        409,
        `El código de barras ${codigoBarras} ya pertenece a otro producto`
      );
    }
  }

  const existenteResultado = await client.query(
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

  if (existenteResultado.rows.length > 0) {
    const existente = existenteResultado.rows[0];

    if (
      sku &&
      existente.sku &&
      String(existente.sku).toLowerCase() !== String(sku).toLowerCase()
    ) {
      throw crearErrorHttp(
        409,
        `La combinación ${nombreVariante} ya existe con otro SKU`
      );
    }

    if (
      codigoBarras &&
      existente.codigo_barras &&
      String(existente.codigo_barras) !== String(codigoBarras)
    ) {
      throw crearErrorHttp(
        409,
        `La combinación ${nombreVariante} ya existe con otro código de barras`
      );
    }

    const actualizado = await client.query(
      `
        UPDATE producto_variantes
        SET
          nombre_variante = COALESCE(NULLIF($1, ''), nombre_variante),
          sku = COALESCE(NULLIF($2, ''), sku),
          codigo_barras = COALESCE(NULLIF($3, ''), codigo_barras),
          precio_compra = $4,
          activo = true,
          fecha_actualizacion = CURRENT_TIMESTAMP
        WHERE id_variante = $5
        RETURNING *
      `,
      [nombreVariante, sku, codigoBarras, Number(precioCompra || 0), existente.id_variante]
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
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,true,$11::jsonb)
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
      Number(precioCompra || producto.precio_compra || 0),
      Number(producto.precio_venta || 0),
      JSON.stringify(atributos),
    ]
  );

  return creado.rows[0];
};

const crearErrorHttp = (status, mensaje) => {
  const error = new Error(mensaje);
  error.status = status;
  return error;
};

const parsearAtributos = (valor) => {
  if (!valor) return {};
  if (typeof valor === 'object' && !Array.isArray(valor)) return valor;

  try {
    const parsed = JSON.parse(valor);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
};

const obtenerValorAtributoVariante = (variante = {}, clave) => {
  const atributos = parsearAtributos(variante.atributos);

  const valoresDirectos = {
    talla: variante.talla,
    color: variante.color,
    tono: variante.tono,
    presentacion: variante.presentacion,
  };

  return normalizarTextoNullable(
    valoresDirectos[clave] ?? atributos?.[clave]
  );
};

const varianteCumpleConfiguracionProducto = (variante, configuracion) => {
  const claves = obtenerClavesVariantesConfiguradas(configuracion);

  if (claves.length === 0) return true;

  return claves.every((clave) =>
    Boolean(obtenerValorAtributoVariante(variante, clave))
  );
};

const obtenerEtiquetaVariante = (variante = {}) => {
  if (!variante?.id_variante) return null;

  const nombre = String(variante.nombre_variante || '').trim();
  if (nombre) return nombre;

  const atributos = parsearAtributos(variante.atributos);
  const valores = [
    variante.talla,
    variante.color,
    variante.tono,
    variante.presentacion,
    ...Object.values(atributos),
  ]
    .map((valor) => String(valor ?? '').trim())
    .filter(Boolean);

  const unicos = [...new Set(valores)];
  return unicos.join(' · ') || `Variante #${variante.id_variante}`;
};

const obtenerBodyCompra = (req) => {
  if (!req.body?.data) return req.body || {};

  try {
    return JSON.parse(req.body.data);
  } catch {
    throw crearErrorHttp(400, 'El formato de los datos de la compra no es válido');
  }
};

const validarProveedorSucursalSesion = async ({
  client,
  id_proveedor,
  id_sucursal,
  id_sesion,
}) => {
  if (!id_sucursal || !id_proveedor) {
    throw crearErrorHttp(400, 'Sucursal y proveedor son obligatorios');
  }

  const proveedorExiste = await client.query(
    `
      SELECT id_proveedor, nombre, activo
      FROM proveedores
      WHERE id_proveedor = $1
    `,
    [id_proveedor]
  );

  if (proveedorExiste.rows.length === 0) {
    throw crearErrorHttp(404, 'Proveedor no encontrado');
  }

  if (!normalizarBooleano(proveedorExiste.rows[0].activo)) {
    throw crearErrorHttp(400, 'El proveedor está inactivo');
  }

  const sucursalExiste = await client.query(
    `
      SELECT id_sucursal
      FROM sucursales
      WHERE id_sucursal = $1
        AND activo = true
    `,
    [id_sucursal]
  );

  if (sucursalExiste.rows.length === 0) {
    throw crearErrorHttp(404, 'Sucursal no encontrada o inactiva');
  }

  if (id_sesion) {
    const sesionExiste = await client.query(
      `
        SELECT id_sesion
        FROM caja_sesiones
        WHERE id_sesion = $1
          AND id_sucursal = $2
          AND estado = 'ABIERTA'
      `,
      [id_sesion, id_sucursal]
    );

    if (sesionExiste.rows.length === 0) {
      throw crearErrorHttp(
        400,
        'La sesión de caja no existe, no pertenece a la sucursal o no está abierta'
      );
    }
  }

  return proveedorExiste.rows[0];
};

const prepararItemCompra = async ({ client, item }) => {
  const {
    id_producto,
    id_variante = null,
    variante_nueva = null,
    cantidad,
    precio_compra,
    descuento: descuentoProducto = 0,
    lote,
    fecha_caducidad,
    ubicacion,
    observaciones: observacionesDetalle,
  } = item || {};

  if (!id_producto || !cantidad || Number(cantidad) <= 0) {
    throw crearErrorHttp(
      400,
      'Cada producto debe tener id_producto y cantidad mayor a cero'
    );
  }

  if (precio_compra === undefined || precio_compra === null || Number(precio_compra) < 0) {
    throw crearErrorHttp(400, 'Cada producto debe tener precio de compra válido');
  }

  const productoResultado = await client.query(
    `
      SELECT
        id_producto,
        nombre,
        activo,
        usa_variantes,
        configuracion_variantes,
        controla_lotes,
        controla_caducidad,
        precio_compra,
        precio_venta
      FROM productos
      WHERE id_producto = $1
      LIMIT 1
    `,
    [id_producto]
  );

  if (productoResultado.rows.length === 0) {
    throw crearErrorHttp(404, `Producto no encontrado: ${id_producto}`);
  }

  const producto = productoResultado.rows[0];

  if (!normalizarBooleano(producto.activo)) {
    throw crearErrorHttp(400, `El producto ${producto.nombre} está inactivo`);
  }

  const usaVariantes = normalizarBooleano(producto.usa_variantes);
  const controlaCaducidad = normalizarBooleano(producto.controla_caducidad);
  const controlaLotes =
    normalizarBooleano(producto.controla_lotes) || controlaCaducidad;

  let variante = null;
  let idVarianteNormalizado = null;

  if (usaVariantes) {
    if (id_variante) {
      const varianteResultado = await client.query(
        `
          SELECT
            id_variante,
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
            atributos,
            activo
          FROM producto_variantes
          WHERE id_variante = $1
            AND id_producto = $2
          LIMIT 1
        `,
        [id_variante, id_producto]
      );

      if (varianteResultado.rows.length === 0) {
        throw crearErrorHttp(
          404,
          `La variante seleccionada no pertenece al producto ${producto.nombre}`
        );
      }

      variante = varianteResultado.rows[0];

      if (!normalizarBooleano(variante.activo)) {
        throw crearErrorHttp(
          400,
          `La variante ${obtenerEtiquetaVariante(variante)} está inactiva`
        );
      }
    } else if (variante_nueva && typeof variante_nueva === 'object') {
      variante = await buscarOCrearVarianteCompra({
        client,
        producto,
        varianteEntrada: variante_nueva,
        precioCompra: precio_compra,
      });
    } else {
      throw crearErrorHttp(
        400,
        `El producto ${producto.nombre} usa variantes. Selecciona una existente o captura una nueva combinación.`
      );
    }

    idVarianteNormalizado = Number(variante.id_variante);
  } else if (id_variante || variante_nueva) {
    throw crearErrorHttp(
      400,
      `El producto ${producto.nombre} no está configurado para usar variantes`
    );
  }

  const loteNormalizado = normalizarLote(lote);

  if (controlaLotes && !loteNormalizado) {
    throw crearErrorHttp(
      400,
      `El producto ${producto.nombre}${variante ? ` · ${obtenerEtiquetaVariante(variante)}` : ''} requiere lote`
    );
  }

  if (controlaCaducidad && !fecha_caducidad) {
    throw crearErrorHttp(
      400,
      `El producto ${producto.nombre}${variante ? ` · ${obtenerEtiquetaVariante(variante)}` : ''} requiere fecha de caducidad`
    );
  }

  const cantidadNum = Number(cantidad);
  const precioCompraNum = Number(precio_compra);
  const descuentoProductoNum = Number(descuentoProducto || 0);
  const subtotalProducto =
    cantidadNum * precioCompraNum - descuentoProductoNum;

  if (subtotalProducto < 0) {
    throw crearErrorHttp(
      400,
      `El subtotal del producto ${producto.nombre} no puede ser negativo`
    );
  }

  return {
    id_producto: Number(id_producto),
    id_variante: idVarianteNormalizado,
    producto: producto.nombre,
    variante: variante ? obtenerEtiquetaVariante(variante) : null,
    sku_variante: variante?.sku || null,
    codigo_barras_variante: variante?.codigo_barras || null,
    cantidad: cantidadNum,
    precio_compra: precioCompraNum,
    descuento: descuentoProductoNum,
    subtotal: subtotalProducto,
    controla_lotes: controlaLotes,
    controla_caducidad: controlaCaducidad,
    lote: controlaLotes ? loteNormalizado : 'SIN-LOTE',
    fecha_caducidad: controlaCaducidad ? fecha_caducidad : null,
    ubicacion: String(ubicacion || '').trim() || null,
    observaciones: observacionesDetalle || null,
  };
};

const prepararProductosCompra = async ({ client, productos }) => {
  if (!Array.isArray(productos)) {
    throw crearErrorHttp(400, 'El campo productos debe ser un arreglo');
  }

  const procesados = [];

  for (const item of productos) {
    procesados.push(await prepararItemCompra({ client, item }));
  }

  return procesados;
};

const sumarInventarioCompra = async ({
  client,
  id_sucursal,
  id_proveedor,
  compra,
  detalleCompra,
  item,
  id_usuario,
  textoMovimiento = 'Entrada por compra',
}) => {
  const inventarioResultado = await client.query(
    `
      SELECT id_inventario, stock_actual
      FROM inventario_sucursal
      WHERE id_sucursal = $1
        AND id_producto = $2
      FOR UPDATE
    `,
    [id_sucursal, item.id_producto]
  );

  let stockAnterior = 0;
  let stockNuevo = item.cantidad;

  if (inventarioResultado.rows.length === 0) {
    await client.query(
      `
        INSERT INTO inventario_sucursal (
          id_sucursal,
          id_producto,
          stock_actual,
          stock_minimo,
          ubicacion
        )
        VALUES ($1,$2,$3,0,$4)
      `,
      [id_sucursal, item.id_producto, item.cantidad, item.ubicacion]
    );
  } else {
    stockAnterior = Number(inventarioResultado.rows[0].stock_actual || 0);
    stockNuevo = stockAnterior + item.cantidad;

    await client.query(
      `
        UPDATE inventario_sucursal
        SET
          stock_actual = $1,
          ubicacion = COALESCE(NULLIF($2, ''), ubicacion),
          fecha_actualizacion = CURRENT_TIMESTAMP
        WHERE id_sucursal = $3
          AND id_producto = $4
      `,
      [stockNuevo, item.ubicacion, id_sucursal, item.id_producto]
    );
  }

  if (item.id_variante) {
    const inventarioVarianteResultado = await client.query(
      `
        SELECT id_inventario_variante, stock_actual
        FROM inventario_variantes_sucursal
        WHERE id_sucursal = $1
          AND id_producto = $2
          AND id_variante = $3
        FOR UPDATE
      `,
      [id_sucursal, item.id_producto, item.id_variante]
    );

    if (inventarioVarianteResultado.rows.length === 0) {
      await client.query(
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
        `,
        [
          id_sucursal,
          item.id_producto,
          item.id_variante,
          item.cantidad,
          item.ubicacion,
        ]
      );
    } else {
      const stockVarianteAnterior = Number(
        inventarioVarianteResultado.rows[0].stock_actual || 0
      );

      await client.query(
        `
          UPDATE inventario_variantes_sucursal
          SET
            stock_actual = $1,
            ubicacion = COALESCE(NULLIF($2, ''), ubicacion),
            activo = true,
            fecha_actualizacion = CURRENT_TIMESTAMP
          WHERE id_inventario_variante = $3
        `,
        [
          stockVarianteAnterior + item.cantidad,
          item.ubicacion,
          inventarioVarianteResultado.rows[0].id_inventario_variante,
        ]
      );
    }

    await client.query(
      `
        UPDATE producto_variantes
        SET
          precio_compra = $1,
          fecha_actualizacion = CURRENT_TIMESTAMP
        WHERE id_variante = $2
      `,
      [item.precio_compra, item.id_variante]
    );
  }

  let idLoteMovimiento = null;

  if (item.controla_lotes) {
    const loteResultado = await client.query(
      `
        SELECT id_lote, stock_actual
        FROM inventario_lotes
        WHERE id_sucursal = $1
          AND id_producto = $2
          AND id_variante IS NOT DISTINCT FROM $3::integer
          AND lote = $4
          AND (
            (fecha_caducidad = $5::date)
            OR (fecha_caducidad IS NULL AND $5::date IS NULL)
          )
        FOR UPDATE
      `,
      [
        id_sucursal,
        item.id_producto,
        item.id_variante,
        item.lote,
        item.fecha_caducidad,
      ]
    );

    if (loteResultado.rows.length > 0) {
      const loteActual = loteResultado.rows[0];
      const nuevoStockLote =
        Number(loteActual.stock_actual || 0) + item.cantidad;

      const loteActualizado = await client.query(
        `
          UPDATE inventario_lotes
          SET
            stock_actual = $1,
            precio_compra = $2,
            id_proveedor = $3,
            id_compra = $4,
            id_compra_detalle = $5,
            id_variante = $6,
            activo = true,
            fecha_actualizacion = CURRENT_TIMESTAMP
          WHERE id_lote = $7
          RETURNING id_lote
        `,
        [
          nuevoStockLote,
          item.precio_compra,
          id_proveedor,
          compra.id_compra,
          detalleCompra.id_detalle,
          item.id_variante,
          loteActual.id_lote,
        ]
      );

      idLoteMovimiento = loteActualizado.rows[0].id_lote;
    } else {
      const loteNuevo = await client.query(
        `
          INSERT INTO inventario_lotes (
            id_sucursal,
            id_producto,
            id_variante,
            id_proveedor,
            id_compra,
            id_compra_detalle,
            lote,
            fecha_caducidad,
            stock_actual,
            precio_compra,
            activo
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)
          RETURNING id_lote
        `,
        [
          id_sucursal,
          item.id_producto,
          item.id_variante,
          id_proveedor,
          compra.id_compra,
          detalleCompra.id_detalle,
          item.lote,
          item.fecha_caducidad,
          item.cantidad,
          item.precio_compra,
        ]
      );

      idLoteMovimiento = loteNuevo.rows[0].id_lote;
    }
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
      VALUES ($1,$2,$3,$4,$5,'ENTRADA',$6,$7,$8,$9,$10,$11)
    `,
    [
      id_sucursal,
      item.id_producto,
      item.id_variante,
      idLoteMovimiento,
      id_proveedor,
      item.cantidad,
      stockAnterior,
      stockNuevo,
      compra.folio,
      `${textoMovimiento} ${compra.folio}` +
        `${item.variante ? ` | Variante ${item.variante}` : ''}` +
        `${item.controla_lotes ? ` | Lote ${item.lote}` : ''}`,
      id_usuario,
    ]
  );

  return {
    stock_anterior: stockAnterior,
    stock_nuevo: stockNuevo,
    id_lote: idLoteMovimiento,
  };
};

const restarInventarioCompra = async ({
  client,
  id_sucursal,
  id_proveedor,
  folio,
  item,
  id_usuario,
  tipo_movimiento,
  motivo,
}) => {
  const cantidad = Number(item.cantidad || 0);

  const inventarioResultado = await client.query(
    `
      SELECT id_inventario, stock_actual
      FROM inventario_sucursal
      WHERE id_sucursal = $1
        AND id_producto = $2
      FOR UPDATE
    `,
    [id_sucursal, item.id_producto]
  );

  if (inventarioResultado.rows.length === 0) {
    throw crearErrorHttp(
      400,
      `No se puede ${motivo} porque el producto ya no tiene inventario en la sucursal`
    );
  }

  const stockAnterior = Number(inventarioResultado.rows[0].stock_actual || 0);
  const stockNuevo = stockAnterior - cantidad;

  if (stockNuevo < 0) {
    throw crearErrorHttp(
      400,
      `No se puede ${motivo} porque parte del inventario de ${item.producto || 'un producto'} ya fue vendido o consumido`
    );
  }

  let stockVarianteNuevo = null;

  if (item.id_variante) {
    const varianteResultado = await client.query(
      `
        SELECT id_inventario_variante, stock_actual
        FROM inventario_variantes_sucursal
        WHERE id_sucursal = $1
          AND id_producto = $2
          AND id_variante = $3
        FOR UPDATE
      `,
      [id_sucursal, item.id_producto, item.id_variante]
    );

    if (varianteResultado.rows.length === 0) {
      throw crearErrorHttp(
        400,
        `No se puede ${motivo} porque la variante ya no tiene inventario en la sucursal`
      );
    }

    const stockVarianteAnterior = Number(
      varianteResultado.rows[0].stock_actual || 0
    );
    stockVarianteNuevo = stockVarianteAnterior - cantidad;

    if (stockVarianteNuevo < 0) {
      throw crearErrorHttp(
        400,
        `No se puede ${motivo} porque parte de la variante ${item.variante || item.nombre_variante || item.id_variante} ya fue vendida o consumida`
      );
    }
  }

  let loteActual = null;
  let stockLoteNuevo = null;
  const controlaLotes = normalizarBooleano(item.controla_lotes);

  // Para compras nuevas solo existirán lotes cuando el producto los controle.
  // También intentamos encontrar un lote legacy (SIN-LOTE) para poder editar/cancelar
  // compras creadas antes de esta reestructuración sin dejar stock huérfano.
  const debeBuscarLoteLegacy =
    controlaLotes ||
    Boolean(item.id_detalle) ||
    (item.lote && String(item.lote).trim() !== '');

  if (debeBuscarLoteLegacy) {
    const loteResultado = await client.query(
      `
        SELECT id_lote, stock_actual
        FROM inventario_lotes
        WHERE id_sucursal = $1
          AND id_producto = $2
          AND id_variante IS NOT DISTINCT FROM $3::integer
          AND (
            id_compra_detalle = $6
            OR (
              lote = $4
              AND (
                (fecha_caducidad = $5::date)
                OR (fecha_caducidad IS NULL AND $5::date IS NULL)
              )
            )
          )
        ORDER BY
          CASE WHEN id_compra_detalle = $6 THEN 0 ELSE 1 END,
          id_lote ASC
        LIMIT 1
        FOR UPDATE
      `,
      [
        id_sucursal,
        item.id_producto,
        item.id_variante || null,
        item.lote || 'SIN-LOTE',
        item.fecha_caducidad || null,
        item.id_detalle || null,
      ]
    );

    if (loteResultado.rows.length === 0 && controlaLotes) {
      throw crearErrorHttp(
        400,
        `No se puede ${motivo} porque no se encontró el lote ${item.lote}`
      );
    }

    if (loteResultado.rows.length > 0) {
      loteActual = loteResultado.rows[0];
      stockLoteNuevo = Number(loteActual.stock_actual || 0) - cantidad;

      if (stockLoteNuevo < 0) {
        throw crearErrorHttp(
          400,
          `No se puede ${motivo} porque parte del lote ${item.lote || 'SIN-LOTE'} ya fue vendida o consumida`
        );
      }
    }
  }

  await client.query(
    `
      UPDATE inventario_sucursal
      SET
        stock_actual = $1,
        fecha_actualizacion = CURRENT_TIMESTAMP
      WHERE id_inventario = $2
    `,
    [stockNuevo, inventarioResultado.rows[0].id_inventario]
  );

  if (item.id_variante) {
    await client.query(
      `
        UPDATE inventario_variantes_sucursal
        SET
          stock_actual = $1,
          activo = true,
          fecha_actualizacion = CURRENT_TIMESTAMP
        WHERE id_sucursal = $2
          AND id_producto = $3
          AND id_variante = $4
      `,
      [stockVarianteNuevo, id_sucursal, item.id_producto, item.id_variante]
    );
  }

  if (loteActual) {
    await client.query(
      `
        UPDATE inventario_lotes
        SET
          stock_actual = $1,
          activo = CASE WHEN $1::numeric <= 0::numeric THEN false ELSE true END,
          fecha_actualizacion = CURRENT_TIMESTAMP
        WHERE id_lote = $2
      `,
      [stockLoteNuevo, loteActual.id_lote]
    );
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
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    `,
    [
      id_sucursal,
      item.id_producto,
      item.id_variante || null,
      loteActual?.id_lote || null,
      id_proveedor || null,
      tipo_movimiento,
      cantidad,
      stockAnterior,
      stockNuevo,
      folio,
      `${motivo} ${folio}` +
        `${item.variante || item.nombre_variante ? ` | Variante ${item.variante || item.nombre_variante}` : ''}` +
        `${controlaLotes ? ` | Lote ${item.lote}` : ''}`,
      id_usuario,
    ]
  );
};

const insertarDetalleYStock = async ({
  client,
  compra,
  item,
  id_sucursal,
  id_proveedor,
  id_usuario,
  textoMovimiento,
}) => {
  const detalleResultado = await client.query(
    `
      INSERT INTO compra_detalle (
        id_compra,
        id_producto,
        id_variante,
        cantidad,
        precio_compra,
        descuento,
        subtotal,
        lote,
        fecha_caducidad,
        observaciones
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
    `,
    [
      compra.id_compra,
      item.id_producto,
      item.id_variante,
      item.cantidad,
      item.precio_compra,
      item.descuento,
      item.subtotal,
      item.lote,
      item.fecha_caducidad,
      item.observaciones,
    ]
  );

  const detalleCompra = detalleResultado.rows[0];

  await sumarInventarioCompra({
    client,
    id_sucursal,
    id_proveedor,
    compra,
    detalleCompra,
    item,
    id_usuario,
    textoMovimiento,
  });

  return detalleCompra;
};

const calcularTotalesCompra = ({
  productosProcesados,
  impuesto,
  descuento,
  total_manual,
  monto_pagado,
}) => {
  const subtotalCompra = productosProcesados.reduce(
    (acc, item) => acc + Number(item.subtotal || 0),
    0
  );

  const impuestoNum = Number(impuesto || 0);
  const descuentoNum = Number(descuento || 0);
  const totalManualNum = Number(total_manual || 0);

  const totalCompra =
    productosProcesados.length === 0
      ? totalManualNum - descuentoNum + impuestoNum
      : subtotalCompra - descuentoNum + impuestoNum;

  if (totalCompra < 0) {
    throw crearErrorHttp(400, 'El total de la compra no puede ser negativo');
  }

  const montoPagadoNum = Number(monto_pagado || 0);

  if (montoPagadoNum < 0) {
    throw crearErrorHttp(400, 'El monto pagado no puede ser negativo');
  }

  if (montoPagadoNum > totalCompra) {
    throw crearErrorHttp(
      400,
      'El monto pagado no puede ser mayor al total de la compra'
    );
  }

  const saldo = totalCompra - montoPagadoNum;

  let estado = 'PENDIENTE';
  if (montoPagadoNum > 0 && saldo > 0) estado = 'PARCIAL';
  if (montoPagadoNum > 0 && saldo === 0) estado = 'PAGADA';

  return {
    subtotalCompra,
    impuestoNum,
    descuentoNum,
    totalCompra,
    montoPagadoNum,
    saldo,
    estado,
  };
};

const registrarPagoInicial = async ({
  client,
  compra,
  proveedor,
  id_proveedor,
  id_sucursal,
  id_sesion,
  id_usuario,
  monto,
  metodo_pago,
  contexto,
}) => {
  if (!(Number(monto) > 0)) return;

  if (metodo_pago === 'EFECTIVO' && !id_sesion) {
    throw crearErrorHttp(
      400,
      'Para pagar en efectivo se requiere una sesión de caja abierta'
    );
  }

  await client.query(
    `
      INSERT INTO pagos_proveedor (
        id_compra,
        id_proveedor,
        id_sucursal,
        id_sesion,
        id_usuario,
        monto,
        metodo_pago,
        referencia,
        observaciones
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `,
    [
      compra.id_compra,
      id_proveedor,
      id_sucursal,
      id_sesion,
      id_usuario,
      monto,
      metodo_pago,
      compra.folio,
      `Pago registrado ${contexto} compra ${compra.folio}`,
    ]
  );

  if (metodo_pago === 'EFECTIVO') {
    await client.query(
      `
        INSERT INTO caja_movimientos (
          id_sesion,
          id_sucursal,
          tipo_movimiento,
          concepto,
          monto,
          metodo_pago,
          referencia,
          observaciones,
          id_usuario
        )
        VALUES ($1,$2,'PAGO_PROVEEDOR',$3,$4,'EFECTIVO',$5,$6,$7)
      `,
      [
        id_sesion,
        id_sucursal,
        `Pago proveedor compra ${compra.folio}`,
        monto,
        compra.folio,
        `Salida por pago a proveedor ${proveedor.nombre}`,
        id_usuario,
      ]
    );
  }
};

const responderError = (res, error, accion) => {
  console.error(`Error al ${accion} compra:`, error);

  if (
    error?.code === '42703' &&
    String(error?.message || '').toLowerCase().includes('id_variante')
  ) {
    return res.status(500).json({
      ok: false,
      mensaje:
        'Falta ejecutar la migración SQL de compras por variantes (compra_detalle.id_variante).',
      error: error.message,
    });
  }

  if (
    error?.code === '42P01' &&
    String(error?.message || '')
      .toLowerCase()
      .includes('inventario_variantes_sucursal')
  ) {
    return res.status(500).json({
      ok: false,
      mensaje:
        'Falta ejecutar la migración SQL de inventario por variantes.',
      error: error.message,
    });
  }

  return res.status(error?.status || 500).json({
    ok: false,
    mensaje:
      error?.status && error?.message
        ? error.message
        : `Error interno al ${accion} compra`,
    ...(error?.status ? {} : { error: error?.message }),
  });
};

export const listarVariantesProductoCompra = async (req, res) => {
  try {
    const { id_producto } = req.params;
    const { sucursal } = req.query;

    const idProducto = Number(id_producto);
    const idSucursal =
      sucursal !== undefined && sucursal !== null && sucursal !== ''
        ? Number(sucursal)
        : null;

    if (!Number.isInteger(idProducto) || idProducto <= 0) {
      return res.status(400).json({
        ok: false,
        mensaje: 'El id_producto no es válido',
      });
    }

    const productoResultado = await pool.query(
      `
        SELECT
          id_producto,
          nombre,
          usa_variantes,
          configuracion_variantes,
          activo
        FROM productos
        WHERE id_producto = $1
        LIMIT 1
      `,
      [idProducto]
    );

    if (productoResultado.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        mensaje: 'Producto no encontrado',
      });
    }

    const producto = productoResultado.rows[0];

    if (!normalizarBooleano(producto.activo)) {
      return res.status(400).json({
        ok: false,
        mensaje: 'El producto está inactivo',
      });
    }

    if (!normalizarBooleano(producto.usa_variantes)) {
      return res.json({
        ok: true,
        producto,
        variantes: [],
      });
    }

    const params = [idProducto];
    let joinInventario = '';
    let stockSelect = '0::numeric(12,2) AS stock_sucursal';
    let stockMinimoSelect = '0::numeric(12,2) AS stock_minimo_sucursal';
    let ubicacionSelect = 'NULL::text AS ubicacion_sucursal';
    let inventarioActivoSelect = 'NULL::boolean AS inventario_activo';

    if (Number.isInteger(idSucursal) && idSucursal > 0) {
      params.push(idSucursal);

      joinInventario = `
        LEFT JOIN inventario_variantes_sucursal ivs
          ON ivs.id_variante = pv.id_variante
         AND ivs.id_producto = pv.id_producto
         AND ivs.id_sucursal = $2
      `;

      stockSelect =
        'COALESCE(ivs.stock_actual, 0)::numeric(12,2) AS stock_sucursal';
      stockMinimoSelect =
        'COALESCE(ivs.stock_minimo, 0)::numeric(12,2) AS stock_minimo_sucursal';
      ubicacionSelect = 'ivs.ubicacion AS ubicacion_sucursal';
      inventarioActivoSelect = 'ivs.activo AS inventario_activo';
    }

    const variantesResultado = await pool.query(
      `
        SELECT
          pv.id_variante,
          pv.id_producto,
          pv.sku,
          pv.codigo_barras,
          pv.nombre_variante,
          pv.talla,
          pv.color,
          pv.tono,
          pv.presentacion,
          pv.precio_compra,
          pv.precio_venta,
          COALESCE(pv.atributos, '{}'::jsonb) AS atributos,
          pv.es_principal,
          pv.activo,
          ${stockSelect},
          ${stockMinimoSelect},
          ${ubicacionSelect},
          ${inventarioActivoSelect}
        FROM producto_variantes pv
        ${joinInventario}
        WHERE pv.id_producto = $1
          AND pv.activo = true
        ORDER BY
          CASE
            WHEN ${Number.isInteger(idSucursal) && idSucursal > 0 ? 'ivs.id_inventario_variante IS NOT NULL' : 'false'}
            THEN 0
            ELSE 1
          END,
          pv.nombre_variante ASC NULLS LAST,
          pv.id_variante ASC
      `,
      params
    );

    const configuracion = normalizarConfiguracionVariantes(
      producto.configuracion_variantes
    );

    const clavesConfiguradas = obtenerClavesVariantesConfiguradas(configuracion);

    const variantesCompatibles = variantesResultado.rows
      .filter((variante) =>
        varianteCumpleConfiguracionProducto(variante, configuracion)
      )
      .map((variante) => ({
        ...variante,
        etiqueta: obtenerEtiquetaVariante(variante),
      }));

    return res.json({
      ok: true,
      producto: {
        ...producto,
        configuracion_variantes: configuracion,
      },
      dimensiones: clavesConfiguradas,
      variantes: variantesCompatibles,
    });
  } catch (error) {
    console.error('Error al listar variantes para compra:', error);

    return res.status(500).json({
      ok: false,
      mensaje: 'Error interno al listar variantes del producto',
      error: error.message,
    });
  }
};

export const crearCompra = async (req, res) => {
  const client = await pool.connect();

  try {
    const body = obtenerBodyCompra(req);

    const {
      id_sucursal,
      id_proveedor,
      productos = [],
      impuesto = 0,
      descuento = 0,
      total_manual = 0,
      metodo_pago = 'PENDIENTE',
      monto_pagado = 0,
      id_sesion = null,
      observaciones,
    } = body;

    const ticketProveedorUrl = req.file
      ? `/uploads/tickets_proveedor/${req.file.filename}`
      : null;

    await client.query('BEGIN');

    const proveedor = await validarProveedorSucursalSesion({
      client,
      id_proveedor,
      id_sucursal,
      id_sesion,
    });

    const productosProcesados = await prepararProductosCompra({
      client,
      productos,
    });

    const {
      subtotalCompra,
      impuestoNum,
      descuentoNum,
      totalCompra,
      montoPagadoNum,
      saldo,
      estado,
    } = calcularTotalesCompra({
      productosProcesados,
      impuesto,
      descuento,
      total_manual,
      monto_pagado,
    });

    const folio = generarFolioCompra();

    const compraResultado = await client.query(
      `
        INSERT INTO compras (
          folio,
          id_sucursal,
          id_proveedor,
          id_usuario,
          subtotal,
          impuesto,
          descuento,
          total,
          monto_pagado,
          saldo,
          metodo_pago,
          estado,
          id_sesion,
          observaciones,
          ticket_proveedor_url
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        RETURNING *
      `,
      [
        folio,
        id_sucursal,
        id_proveedor,
        req.usuario.id_usuario,
        subtotalCompra,
        impuestoNum,
        descuentoNum,
        totalCompra,
        montoPagadoNum,
        saldo,
        metodo_pago,
        estado,
        id_sesion,
        observaciones || null,
        ticketProveedorUrl,
      ]
    );

    const compra = compraResultado.rows[0];

    for (const item of productosProcesados) {
      await insertarDetalleYStock({
        client,
        compra,
        item,
        id_sucursal,
        id_proveedor,
        id_usuario: req.usuario.id_usuario,
        textoMovimiento: 'Entrada por compra',
      });
    }

    await registrarPagoInicial({
      client,
      compra,
      proveedor,
      id_proveedor,
      id_sucursal,
      id_sesion,
      id_usuario: req.usuario.id_usuario,
      monto: montoPagadoNum,
      metodo_pago,
      contexto: 'al crear',
    });

    await client.query('COMMIT');

    return res.status(201).json({
      ok: true,
      mensaje: 'Compra registrada correctamente',
      compra: {
        ...compra,
        productos: productosProcesados,
      },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    return responderError(res, error, 'crear');
  } finally {
    client.release();
  }
};

export const listarCompras = async (req, res) => {
  try {
    const { sucursal, proveedor, estado, fecha_inicio, fecha_fin } = req.query;

    let query = `
      SELECT
        c.id_compra,
        c.folio,
        c.id_sucursal,
        s.nombre AS sucursal,
        c.id_proveedor,
        p.nombre AS proveedor,
        c.id_usuario,
        u.nombre AS usuario,
        c.subtotal,
        c.impuesto,
        c.descuento,
        c.total,
        c.monto_pagado,
        c.saldo,
        c.metodo_pago,
        c.estado,
        c.id_sesion,
        c.observaciones,
        c.ticket_proveedor_url,
        c.fecha_compra
      FROM compras c
      INNER JOIN sucursales s ON s.id_sucursal = c.id_sucursal
      INNER JOIN proveedores p ON p.id_proveedor = c.id_proveedor
      INNER JOIN usuarios u ON u.id_usuario = c.id_usuario
      WHERE 1 = 1
    `;

    const params = [];

    if (sucursal) {
      params.push(sucursal);
      query += ` AND c.id_sucursal = $${params.length} `;
    }

    if (proveedor) {
      params.push(proveedor);
      query += ` AND c.id_proveedor = $${params.length} `;
    }

    if (estado) {
      params.push(estado);
      query += ` AND c.estado = $${params.length} `;
    }

    if (fecha_inicio) {
      params.push(fecha_inicio);
      query += ` AND c.fecha_compra >= $${params.length} `;
    }

    if (fecha_fin) {
      params.push(fecha_fin);
      query += ` AND c.fecha_compra <= $${params.length} `;
    }

    query += ` ORDER BY c.fecha_compra DESC `;

    const resultado = await pool.query(query, params);

    return res.json({
      ok: true,
      compras: resultado.rows,
    });
  } catch (error) {
    console.error('Error al listar compras:', error);

    return res.status(500).json({
      ok: false,
      mensaje: 'Error interno al listar compras',
    });
  }
};

export const obtenerCompra = async (req, res) => {
  try {
    const { id } = req.params;

    const compraResultado = await pool.query(
      `
        SELECT
          c.id_compra,
          c.folio,
          c.id_sucursal,
          s.nombre AS sucursal,
          c.id_proveedor,
          p.nombre AS proveedor,
          p.rfc AS proveedor_rfc,
          c.id_usuario,
          u.nombre AS usuario,
          c.subtotal,
          c.impuesto,
          c.descuento,
          c.total,
          c.monto_pagado,
          c.saldo,
          c.metodo_pago,
          c.estado,
          c.id_sesion,
          c.observaciones,
          c.ticket_proveedor_url,
          c.fecha_compra
        FROM compras c
        INNER JOIN sucursales s ON s.id_sucursal = c.id_sucursal
        INNER JOIN proveedores p ON p.id_proveedor = c.id_proveedor
        INNER JOIN usuarios u ON u.id_usuario = c.id_usuario
        WHERE c.id_compra = $1
      `,
      [id]
    );

    if (compraResultado.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        mensaje: 'Compra no encontrada',
      });
    }

    const compra = compraResultado.rows[0];

    const detalleResultado = await pool.query(
      `
        SELECT
          cd.id_detalle,
          cd.id_producto,
          cd.id_variante,
          pr.codigo_barras,
          pr.nombre AS producto,
          pr.usa_variantes,
          pr.controla_lotes,
          pr.controla_caducidad,
          pv.nombre_variante,
          pv.sku AS sku_variante,
          pv.codigo_barras AS codigo_barras_variante,
          pv.talla,
          pv.color,
          pv.tono,
          pv.presentacion AS presentacion_variante,
          COALESCE(pv.atributos, '{}'::jsonb) AS atributos_variante,
          cd.cantidad,
          cd.precio_compra,
          cd.descuento,
          cd.subtotal,
          cd.lote,
          cd.fecha_caducidad,
          COALESCE(ivs.ubicacion, inv.ubicacion) AS ubicacion,
          cd.observaciones
        FROM compra_detalle cd
        INNER JOIN productos pr
          ON pr.id_producto = cd.id_producto
        LEFT JOIN producto_variantes pv
          ON pv.id_variante = cd.id_variante
        LEFT JOIN inventario_sucursal inv
          ON inv.id_sucursal = $2
         AND inv.id_producto = cd.id_producto
        LEFT JOIN inventario_variantes_sucursal ivs
          ON ivs.id_sucursal = $2
         AND ivs.id_producto = cd.id_producto
         AND ivs.id_variante = cd.id_variante
        WHERE cd.id_compra = $1
        ORDER BY cd.id_detalle ASC
      `,
      [id, compra.id_sucursal]
    );

    const pagosResultado = await pool.query(
      `
        SELECT
          pp.id_pago,
          pp.id_compra,
          pp.id_proveedor,
          pp.id_sucursal,
          pp.id_sesion,
          pp.monto,
          pp.metodo_pago,
          pp.referencia,
          pp.observaciones,
          pp.fecha_pago,
          cs.id_caja,
          cj.nombre AS caja,
          u.nombre AS usuario
        FROM pagos_proveedor pp
        INNER JOIN usuarios u ON u.id_usuario = pp.id_usuario
        LEFT JOIN caja_sesiones cs ON cs.id_sesion = pp.id_sesion
        LEFT JOIN cajas cj ON cj.id_caja = cs.id_caja
        WHERE pp.id_compra = $1
        ORDER BY pp.fecha_pago DESC
      `,
      [id]
    );

    return res.json({
      ok: true,
      compra,
      detalle: detalleResultado.rows.map((item) => ({
        ...item,
        variante: item.id_variante
          ? obtenerEtiquetaVariante({
              id_variante: item.id_variante,
              nombre_variante: item.nombre_variante,
              talla: item.talla,
              color: item.color,
              tono: item.tono,
              presentacion: item.presentacion_variante,
              atributos: item.atributos_variante,
            })
          : null,
      })),
      pagos: pagosResultado.rows,
    });
  } catch (error) {
    console.error('Error al obtener compra:', error);

    return res.status(500).json({
      ok: false,
      mensaje: 'Error interno al obtener compra',
      error: error.message,
    });
  }
};

export const actualizarCompra = async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;
    const body = obtenerBodyCompra(req);

    const {
      id_sucursal,
      id_proveedor,
      productos = [],
      impuesto = 0,
      descuento = 0,
      total_manual = 0,
      metodo_pago = 'PENDIENTE',
      monto_pagado = 0,
      id_sesion = null,
      observaciones,
    } = body;

    const ticketProveedorUrl = req.file
      ? `/uploads/tickets_proveedor/${req.file.filename}`
      : null;

    await client.query('BEGIN');

    const compraActualResultado = await client.query(
      `
        SELECT *
        FROM compras
        WHERE id_compra = $1
        FOR UPDATE
      `,
      [id]
    );

    if (compraActualResultado.rows.length === 0) {
      throw crearErrorHttp(404, 'Compra no encontrada');
    }

    const compraActual = compraActualResultado.rows[0];

    if (compraActual.estado !== 'PENDIENTE') {
      throw crearErrorHttp(400, 'Solo se pueden editar compras pendientes');
    }

    const proveedor = await validarProveedorSucursalSesion({
      client,
      id_proveedor,
      id_sucursal,
      id_sesion,
    });

    const detalleAnteriorResultado = await client.query(
      `
        SELECT
          cd.id_detalle,
          cd.id_producto,
          cd.id_variante,
          cd.cantidad,
          cd.lote,
          cd.fecha_caducidad,
          p.nombre AS producto,
          p.controla_lotes,
          pv.nombre_variante,
          pv.talla,
          pv.color,
          pv.tono,
          pv.presentacion,
          COALESCE(pv.atributos, '{}'::jsonb) AS atributos
        FROM compra_detalle cd
        INNER JOIN productos p ON p.id_producto = cd.id_producto
        LEFT JOIN producto_variantes pv ON pv.id_variante = cd.id_variante
        WHERE cd.id_compra = $1
        ORDER BY cd.id_detalle ASC
      `,
      [id]
    );

    for (const item of detalleAnteriorResultado.rows) {
      await restarInventarioCompra({
        client,
        id_sucursal: compraActual.id_sucursal,
        id_proveedor: compraActual.id_proveedor,
        folio: compraActual.folio,
        item: {
          ...item,
          variante: item.id_variante
            ? obtenerEtiquetaVariante({
                id_variante: item.id_variante,
                nombre_variante: item.nombre_variante,
                talla: item.talla,
                color: item.color,
                tono: item.tono,
                presentacion: item.presentacion,
                atributos: item.atributos,
              })
            : null,
        },
        id_usuario: req.usuario.id_usuario,
        tipo_movimiento: 'AJUSTE_NEGATIVO',
        motivo: 'editar la compra',
      });
    }

    // Evita violaciones de FK al sustituir el detalle de una compra.
    await client.query(
      `
        UPDATE inventario_lotes
        SET id_compra_detalle = NULL
        WHERE id_compra_detalle IN (
          SELECT id_detalle
          FROM compra_detalle
          WHERE id_compra = $1
        )
      `,
      [id]
    );

    await client.query(
      `
        DELETE FROM compra_detalle
        WHERE id_compra = $1
      `,
      [id]
    );

    const productosProcesados = await prepararProductosCompra({
      client,
      productos,
    });

    const {
      subtotalCompra,
      impuestoNum,
      descuentoNum,
      totalCompra,
      montoPagadoNum,
      saldo,
      estado,
    } = calcularTotalesCompra({
      productosProcesados,
      impuesto,
      descuento,
      total_manual,
      monto_pagado,
    });

    const pagosPreviosResultado = await client.query(
      `
        SELECT COALESCE(SUM(monto), 0)::numeric(12,2) AS total_pagado
        FROM pagos_proveedor
        WHERE id_compra = $1
      `,
      [id]
    );

    const totalPagadoPrevio = Number(
      pagosPreviosResultado.rows[0]?.total_pagado || 0
    );

    if (montoPagadoNum < totalPagadoPrevio) {
      throw crearErrorHttp(
        400,
        `El monto pagado no puede ser menor a los pagos ya registrados (${totalPagadoPrevio.toFixed(2)})`
      );
    }

    let updateQuery = `
      UPDATE compras
      SET
        id_sucursal = $1,
        id_proveedor = $2,
        subtotal = $3,
        impuesto = $4,
        descuento = $5,
        total = $6,
        monto_pagado = $7,
        saldo = $8,
        metodo_pago = $9,
        estado = $10,
        id_sesion = $11,
        observaciones = $12
    `;

    const updateParams = [
      id_sucursal,
      id_proveedor,
      subtotalCompra,
      impuestoNum,
      descuentoNum,
      totalCompra,
      montoPagadoNum,
      saldo,
      metodo_pago,
      estado,
      id_sesion,
      observaciones || null,
    ];

    if (ticketProveedorUrl) {
      updateParams.push(ticketProveedorUrl);
      updateQuery += `, ticket_proveedor_url = $${updateParams.length}`;
    }

    updateParams.push(id);

    updateQuery += `
      WHERE id_compra = $${updateParams.length}
      RETURNING *
    `;

    const compraActualizadaResultado = await client.query(
      updateQuery,
      updateParams
    );

    const compraActualizada = compraActualizadaResultado.rows[0];

    for (const item of productosProcesados) {
      await insertarDetalleYStock({
        client,
        compra: compraActualizada,
        item,
        id_sucursal,
        id_proveedor,
        id_usuario: req.usuario.id_usuario,
        textoMovimiento: 'Entrada por edición de compra',
      });
    }

    const montoNuevoPago = montoPagadoNum - totalPagadoPrevio;

    if (montoNuevoPago > 0) {
      await registrarPagoInicial({
        client,
        compra: compraActualizada,
        proveedor,
        id_proveedor,
        id_sucursal,
        id_sesion,
        id_usuario: req.usuario.id_usuario,
        monto: montoNuevoPago,
        metodo_pago,
        contexto: 'al editar',
      });
    }

    await client.query('COMMIT');

    return res.json({
      ok: true,
      mensaje: 'Compra actualizada correctamente',
      compra: {
        ...compraActualizada,
        productos: productosProcesados,
      },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    return responderError(res, error, 'actualizar');
  } finally {
    client.release();
  }
};

export const cancelarCompra = async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;

    await client.query('BEGIN');

    const compraResultado = await client.query(
      `
        SELECT *
        FROM compras
        WHERE id_compra = $1
        FOR UPDATE
      `,
      [id]
    );

    if (compraResultado.rows.length === 0) {
      throw crearErrorHttp(404, 'Compra no encontrada');
    }

    const compra = compraResultado.rows[0];

    if (compra.estado === 'CANCELADA') {
      throw crearErrorHttp(400, 'La compra ya está cancelada');
    }

    if (compra.estado === 'PAGADA') {
      throw crearErrorHttp(
        400,
        'No puedes cancelar una compra pagada. Primero registra una devolución o ajuste.'
      );
    }

    const detalleResultado = await client.query(
      `
        SELECT
          cd.id_detalle,
          cd.id_producto,
          cd.id_variante,
          cd.cantidad,
          cd.lote,
          cd.fecha_caducidad,
          p.nombre AS producto,
          p.controla_lotes,
          pv.nombre_variante,
          pv.talla,
          pv.color,
          pv.tono,
          pv.presentacion,
          COALESCE(pv.atributos, '{}'::jsonb) AS atributos
        FROM compra_detalle cd
        INNER JOIN productos p ON p.id_producto = cd.id_producto
        LEFT JOIN producto_variantes pv ON pv.id_variante = cd.id_variante
        WHERE cd.id_compra = $1
        ORDER BY cd.id_detalle ASC
      `,
      [id]
    );

    for (const item of detalleResultado.rows) {
      await restarInventarioCompra({
        client,
        id_sucursal: compra.id_sucursal,
        id_proveedor: compra.id_proveedor,
        folio: compra.folio,
        item: {
          ...item,
          variante: item.id_variante
            ? obtenerEtiquetaVariante({
                id_variante: item.id_variante,
                nombre_variante: item.nombre_variante,
                talla: item.talla,
                color: item.color,
                tono: item.tono,
                presentacion: item.presentacion,
                atributos: item.atributos,
              })
            : null,
        },
        id_usuario: req.usuario.id_usuario,
        tipo_movimiento: 'AJUSTE',
        motivo: 'cancelar la compra',
      });
    }

    await client.query(
      `
        UPDATE compras
        SET
          estado = 'CANCELADA',
          saldo = 0
        WHERE id_compra = $1
      `,
      [id]
    );

    await client.query('COMMIT');

    return res.json({
      ok: true,
      mensaje: 'Compra cancelada correctamente',
    });
  } catch (error) {
    await client.query('ROLLBACK');
    return responderError(res, error, 'cancelar');
  } finally {
    client.release();
  }
};
