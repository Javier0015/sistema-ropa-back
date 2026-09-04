import { pool } from '../config/db.js';

const normalizarBooleano = (valor, valorDefault = false) => {
  if (valor === undefined || valor === null || valor === '') {
    return valorDefault;
  }

  if (typeof valor === 'boolean') {
    return valor;
  }

  const texto = String(valor).trim().toLowerCase();

  if (['true', '1', 'si', 'sí', 's'].includes(texto)) {
    return true;
  }

  if (['false', '0', 'no', 'n'].includes(texto)) {
    return false;
  }

  return Boolean(valor);
};

const normalizarId = (valor) => {
  if (
    valor === undefined ||
    valor === null ||
    valor === ''
  ) {
    return null;
  }

  const numero = Number(valor);

  return Number.isInteger(numero) && numero > 0
    ? numero
    : null;
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
  precio: false,
  personalizados: [],
};

const clavesVariantesPermitidas = [
  'talla',
  'color',
  'tono',
  'genero',
  'presentacion',
  'material',
  'modelo',
  'aroma',
  'capacidad',
  'precio',
];

const crearClaveAtributo = (texto) => {
  return String(texto || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
};

const normalizarConfiguracionVariantes = (valor, usaVariantes = false) => {
  if (!usaVariantes) {
    return { ...configuracionVariantesDefault };
  }

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

  const configuracion = { ...configuracionVariantesDefault };

  for (const clave of clavesVariantesPermitidas) {
    configuracion[clave] = normalizarBooleano(origen[clave], false);
  }

  const personalizadosEntrada = Array.isArray(origen.personalizados)
    ? origen.personalizados
    : [];

  const vistos = new Set();
  configuracion.personalizados = personalizadosEntrada
    .map((item) => {
      const etiqueta = String(item?.etiqueta || '').trim().slice(0, 80);
      const clave = crearClaveAtributo(item?.clave || etiqueta);
      return { clave, etiqueta };
    })
    .filter((item) => {
      if (!item.clave || !item.etiqueta) return false;
      if (clavesVariantesPermitidas.includes(item.clave)) return false;
      if (vistos.has(item.clave)) return false;
      vistos.add(item.clave);
      return true;
    });

  return configuracion;
};

const tieneConfiguracionVariantes = (configuracion) => {
  return (
    clavesVariantesPermitidas.some((clave) => Boolean(configuracion?.[clave])) ||
    (Array.isArray(configuracion?.personalizados) &&
      configuracion.personalizados.length > 0)
  );
};

export const listarProductos = async (req, res) => {
  try {
    const {
      buscar = '',
      activos,
      autocomplete = '',
      limit = 10,
      id_producto,
    } = req.query;

    const textoBusqueda = String(
      buscar || ''
    ).trim();

    const esAutocomplete =
      String(autocomplete).toLowerCase() === 'true' ||
      String(autocomplete) === '1';

    const idProducto =
      id_producto !== undefined &&
      id_producto !== null &&
      id_producto !== ''
        ? Number(id_producto)
        : null;

    if (
      idProducto !== null &&
      (!Number.isInteger(idProducto) ||
        idProducto <= 0)
    ) {
      return res.status(400).json({
        ok: false,
        mensaje: 'El id_producto no es válido',
      });
    }

    let query = `
      SELECT
        p.id_producto,
        p.codigo_barras,
        p.nombre,
        p.descripcion,
        p.id_categoria,
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
        p.fecha_creacion
      FROM productos p
      LEFT JOIN categorias c
        ON c.id_categoria = p.id_categoria
      LEFT JOIN marcas m
        ON m.id_marca = p.id_marca
      WHERE 1 = 1
    `;

    const params = [];
    let ordenamiento = 'p.nombre ASC';

    if (idProducto !== null) {
      params.push(idProducto);

      query += `
        AND p.id_producto = $${params.length}
      `;
    } else if (textoBusqueda) {
      params.push(`%${textoBusqueda}%`);
      const indiceLike = params.length;

      params.push(textoBusqueda);
      const indiceExacto = params.length;

      query += `
        AND (
          p.nombre ILIKE $${indiceLike}
          OR p.codigo_barras ILIKE $${indiceLike}
          OR p.descripcion ILIKE $${indiceLike}
          OR p.presentacion ILIKE $${indiceLike}
          OR c.nombre ILIKE $${indiceLike}
          OR m.nombre ILIKE $${indiceLike}
        )
      `;

      ordenamiento = `
        CASE
          WHEN p.codigo_barras = $${indiceExacto} THEN 1
          WHEN LOWER(p.nombre) = LOWER($${indiceExacto}) THEN 2
          WHEN p.nombre ILIKE $${indiceLike} THEN 3
          WHEN p.descripcion ILIKE $${indiceLike} THEN 4
          WHEN m.nombre ILIKE $${indiceLike} THEN 5
          WHEN p.presentacion ILIKE $${indiceLike} THEN 6
          WHEN c.nombre ILIKE $${indiceLike} THEN 7
          ELSE 8
        END,
        p.nombre ASC
      `;
    }

    if (
      String(activos).toLowerCase() === 'true' ||
      String(activos) === '1'
    ) {
      query += `
        AND p.activo = true
      `;
    }

    query += `
      ORDER BY ${ordenamiento}
    `;

    if (esAutocomplete) {
      const limiteNumerico = Number.parseInt(
        limit,
        10
      );

      const limiteSeguro =
        Number.isInteger(limiteNumerico) &&
        limiteNumerico > 0
          ? Math.min(limiteNumerico, 20)
          : 10;

      params.push(limiteSeguro);

      query += `
        LIMIT $${params.length}
      `;
    }

    const resultado = await pool.query(
      query,
      params
    );

    return res.json({
      ok: true,
      productos: resultado.rows,
    });
  } catch (error) {
    console.error(
      'Error al listar productos:',
      error
    );

    return res.status(500).json({
      ok: false,
      mensaje:
        'Error interno al listar productos',
    });
  }
};

export const obtenerProducto = async (
  req,
  res
) => {
  try {
    const { id } = req.params;

    const idProducto = Number(id);

    if (
      !Number.isInteger(idProducto) ||
      idProducto <= 0
    ) {
      return res.status(400).json({
        ok: false,
        mensaje: 'El id_producto no es válido',
      });
    }

    const resultado = await pool.query(
      `
        SELECT
          p.id_producto,
          p.codigo_barras,
          p.nombre,
          p.descripcion,
          p.id_categoria,
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
          p.fecha_creacion
        FROM productos p
        LEFT JOIN categorias c
          ON c.id_categoria = p.id_categoria
        LEFT JOIN marcas m
          ON m.id_marca = p.id_marca
        WHERE p.id_producto = $1
        LIMIT 1
      `,
      [idProducto]
    );

    if (resultado.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        mensaje: 'Producto no encontrado',
      });
    }

    return res.json({
      ok: true,
      producto: resultado.rows[0],
    });
  } catch (error) {
    console.error(
      'Error al obtener producto:',
      error
    );

    return res.status(500).json({
      ok: false,
      mensaje:
        'Error interno al obtener producto',
    });
  }
};

export const crearProducto = async (
  req,
  res
) => {
  const cliente = await pool.connect();

  try {
    const {
      codigo_barras,
      nombre,
      descripcion,
      id_categoria,
      id_marca,
      presentacion,
      precio_compra,
      precio_venta,
      usa_variantes,
      configuracion_variantes,
      controla_lotes,
      controla_caducidad,
      activo = true,
    } = req.body;

    if (
      !nombre ||
      !String(nombre).trim()
    ) {
      return res.status(400).json({
        ok: false,
        mensaje:
          'El nombre del producto es obligatorio',
      });
    }

    if (
      precio_venta === undefined ||
      precio_venta === null ||
      precio_venta === '' ||
      Number(precio_venta) < 0
    ) {
      return res.status(400).json({
        ok: false,
        mensaje:
          'El precio de venta es obligatorio y no puede ser negativo',
      });
    }

    if (
      Number(precio_compra || 0) < 0
    ) {
      return res.status(400).json({
        ok: false,
        mensaje:
          'El precio de compra no puede ser negativo',
      });
    }

    const codigoNormalizado =
      codigo_barras &&
      String(codigo_barras).trim()
        ? String(codigo_barras).trim()
        : null;

    const categoriaNormalizada =
      normalizarId(id_categoria);

    const marcaNormalizada =
      normalizarId(id_marca);

    const usaVariantesNormalizado =
      normalizarBooleano(
        usa_variantes,
        false
      );

    const configuracionVariantesNormalizada =
      normalizarConfiguracionVariantes(
        configuracion_variantes,
        usaVariantesNormalizado
      );

    if (
      usaVariantesNormalizado &&
      !tieneConfiguracionVariantes(configuracionVariantesNormalizada)
    ) {
      return res.status(400).json({
        ok: false,
        mensaje:
          'Selecciona al menos un tipo de variante para el producto',
      });
    }

    let controlaLotesNormalizado =
      normalizarBooleano(
        controla_lotes,
        false
      );

    const controlaCaducidadNormalizado =
      normalizarBooleano(
        controla_caducidad,
        false
      );

    if (controlaCaducidadNormalizado) {
      controlaLotesNormalizado = true;
    }

    const activoNormalizado =
      normalizarBooleano(activo, true);

    await cliente.query('BEGIN');

    if (codigoNormalizado) {
      const existeCodigo =
        await cliente.query(
          `
            SELECT id_producto
            FROM productos
            WHERE codigo_barras = $1
            LIMIT 1
          `,
          [codigoNormalizado]
        );

      if (
        existeCodigo.rows.length > 0
      ) {
        await cliente.query('ROLLBACK');

        return res.status(409).json({
          ok: false,
          mensaje:
            'Ya existe un producto con ese código de barras',
        });
      }
    }

    if (categoriaNormalizada) {
      const categoriaExiste =
        await cliente.query(
          `
            SELECT id_categoria
            FROM categorias
            WHERE id_categoria = $1
            LIMIT 1
          `,
          [categoriaNormalizada]
        );

      if (
        categoriaExiste.rows.length === 0
      ) {
        await cliente.query('ROLLBACK');

        return res.status(400).json({
          ok: false,
          mensaje:
            'La categoría seleccionada no existe',
        });
      }
    }

    if (marcaNormalizada) {
      const marcaExiste =
        await cliente.query(
          `
            SELECT id_marca
            FROM marcas
            WHERE id_marca = $1
            LIMIT 1
          `,
          [marcaNormalizada]
        );

      if (
        marcaExiste.rows.length === 0
      ) {
        await cliente.query('ROLLBACK');

        return res.status(400).json({
          ok: false,
          mensaje:
            'La marca seleccionada no existe',
        });
      }
    }

    const resultado = await cliente.query(
      `
        INSERT INTO productos (
          codigo_barras,
          nombre,
          descripcion,
          id_categoria,
          id_marca,
          presentacion,
          precio_compra,
          precio_venta,
          usa_variantes,
          configuracion_variantes,
          controla_lotes,
          controla_caducidad,
          activo
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10::jsonb,
          $11,
          $12,
          $13
        )
        RETURNING *
      `,
      [
        codigoNormalizado,
        String(nombre).trim(),
        descripcion &&
        String(descripcion).trim()
          ? String(descripcion).trim()
          : null,
        categoriaNormalizada,
        marcaNormalizada,
        presentacion &&
        String(presentacion).trim()
          ? String(presentacion).trim()
          : null,
        Number(precio_compra || 0),
        Number(precio_venta),
        usaVariantesNormalizado,
        JSON.stringify(configuracionVariantesNormalizada),
        controlaLotesNormalizado,
        controlaCaducidadNormalizado,
        activoNormalizado,
      ]
    );

    await cliente.query('COMMIT');

    return res.status(201).json({
      ok: true,
      mensaje:
        'Producto creado correctamente',
      producto: resultado.rows[0],
    });
  } catch (error) {
    await cliente.query('ROLLBACK');

    console.error(
      'Error al crear producto:',
      error
    );

    if (
      error.code === '23505'
    ) {
      return res.status(409).json({
        ok: false,
        mensaje:
          'Ya existe un producto con esos datos',
      });
    }

    return res.status(500).json({
      ok: false,
      mensaje:
        'Error interno al crear producto',
    });
  } finally {
    cliente.release();
  }
};

export const actualizarProducto = async (
  req,
  res
) => {
  const cliente = await pool.connect();

  try {
    const { id } = req.params;

    const idProducto = Number(id);

    if (
      !Number.isInteger(idProducto) ||
      idProducto <= 0
    ) {
      return res.status(400).json({
        ok: false,
        mensaje: 'El id_producto no es válido',
      });
    }

    const {
      codigo_barras,
      nombre,
      descripcion,
      id_categoria,
      id_marca,
      presentacion,
      precio_compra,
      precio_venta,
      usa_variantes,
      configuracion_variantes,
      controla_lotes,
      controla_caducidad,
      activo,
    } = req.body;

    if (
      !nombre ||
      !String(nombre).trim()
    ) {
      return res.status(400).json({
        ok: false,
        mensaje:
          'El nombre del producto es obligatorio',
      });
    }

    if (
      precio_venta === undefined ||
      precio_venta === null ||
      precio_venta === '' ||
      Number(precio_venta) < 0
    ) {
      return res.status(400).json({
        ok: false,
        mensaje:
          'El precio de venta es obligatorio y no puede ser negativo',
      });
    }

    if (
      Number(precio_compra || 0) < 0
    ) {
      return res.status(400).json({
        ok: false,
        mensaje:
          'El precio de compra no puede ser negativo',
      });
    }

    const codigoNormalizado =
      codigo_barras &&
      String(codigo_barras).trim()
        ? String(codigo_barras).trim()
        : null;

    const categoriaNormalizada =
      normalizarId(id_categoria);

    const marcaNormalizada =
      normalizarId(id_marca);

    const usaVariantesNormalizado =
      normalizarBooleano(
        usa_variantes,
        false
      );

    const configuracionVariantesNormalizada =
      normalizarConfiguracionVariantes(
        configuracion_variantes,
        usaVariantesNormalizado
      );

    if (
      usaVariantesNormalizado &&
      !tieneConfiguracionVariantes(configuracionVariantesNormalizada)
    ) {
      return res.status(400).json({
        ok: false,
        mensaje:
          'Selecciona al menos un tipo de variante para el producto',
      });
    }

    let controlaLotesNormalizado =
      normalizarBooleano(
        controla_lotes,
        false
      );

    const controlaCaducidadNormalizado =
      normalizarBooleano(
        controla_caducidad,
        false
      );

    if (controlaCaducidadNormalizado) {
      controlaLotesNormalizado = true;
    }

    await cliente.query('BEGIN');

    const productoExiste =
      await cliente.query(
        `
          SELECT id_producto
          FROM productos
          WHERE id_producto = $1
          LIMIT 1
        `,
        [idProducto]
      );

    if (
      productoExiste.rows.length === 0
    ) {
      await cliente.query('ROLLBACK');

      return res.status(404).json({
        ok: false,
        mensaje: 'Producto no encontrado',
      });
    }

    if (codigoNormalizado) {
      const existeCodigo =
        await cliente.query(
          `
            SELECT id_producto
            FROM productos
            WHERE codigo_barras = $1
              AND id_producto <> $2
            LIMIT 1
          `,
          [
            codigoNormalizado,
            idProducto,
          ]
        );

      if (
        existeCodigo.rows.length > 0
      ) {
        await cliente.query('ROLLBACK');

        return res.status(409).json({
          ok: false,
          mensaje:
            'Ya existe otro producto con ese código de barras',
        });
      }
    }

    if (categoriaNormalizada) {
      const categoriaExiste =
        await cliente.query(
          `
            SELECT id_categoria
            FROM categorias
            WHERE id_categoria = $1
            LIMIT 1
          `,
          [categoriaNormalizada]
        );

      if (
        categoriaExiste.rows.length === 0
      ) {
        await cliente.query('ROLLBACK');

        return res.status(400).json({
          ok: false,
          mensaje:
            'La categoría seleccionada no existe',
        });
      }
    }

    if (marcaNormalizada) {
      const marcaExiste =
        await cliente.query(
          `
            SELECT id_marca
            FROM marcas
            WHERE id_marca = $1
            LIMIT 1
          `,
          [marcaNormalizada]
        );

      if (
        marcaExiste.rows.length === 0
      ) {
        await cliente.query('ROLLBACK');

        return res.status(400).json({
          ok: false,
          mensaje:
            'La marca seleccionada no existe',
        });
      }
    }

    const resultado =
      await cliente.query(
        `
          UPDATE productos
          SET
            codigo_barras = $1,
            nombre = $2,
            descripcion = $3,
            id_categoria = $4,
            id_marca = $5,
            presentacion = $6,
            precio_compra = $7,
            precio_venta = $8,
            usa_variantes = $9,
            configuracion_variantes = $10::jsonb,
            controla_lotes = $11,
            controla_caducidad = $12,
            activo = COALESCE($13, activo)
          WHERE id_producto = $14
          RETURNING *
        `,
        [
          codigoNormalizado,
          String(nombre).trim(),
          descripcion &&
          String(descripcion).trim()
            ? String(
                descripcion
              ).trim()
            : null,
          categoriaNormalizada,
          marcaNormalizada,
          presentacion &&
          String(presentacion).trim()
            ? String(
                presentacion
              ).trim()
            : null,
          Number(
            precio_compra || 0
          ),
          Number(precio_venta),
          usaVariantesNormalizado,
          JSON.stringify(configuracionVariantesNormalizada),
          controlaLotesNormalizado,
          controlaCaducidadNormalizado,
          activo === undefined
            ? null
            : normalizarBooleano(
                activo,
                true
              ),
          idProducto,
        ]
      );

    await cliente.query('COMMIT');

    return res.json({
      ok: true,
      mensaje:
        'Producto actualizado correctamente',
      producto: resultado.rows[0],
    });
  } catch (error) {
    await cliente.query('ROLLBACK');

    console.error(
      'Error al actualizar producto:',
      error
    );

    if (
      error.code === '23505'
    ) {
      return res.status(409).json({
        ok: false,
        mensaje:
          'Ya existe otro producto con esos datos',
      });
    }

    return res.status(500).json({
      ok: false,
      mensaje:
        'Error interno al actualizar producto',
    });
  } finally {
    cliente.release();
  }
};

export const desactivarProducto = async (
  req,
  res
) => {
  try {
    const { id } = req.params;

    const idProducto = Number(id);

    if (
      !Number.isInteger(idProducto) ||
      idProducto <= 0
    ) {
      return res.status(400).json({
        ok: false,
        mensaje: 'El id_producto no es válido',
      });
    }

    const resultado = await pool.query(
      `
        UPDATE productos
        SET activo = false
        WHERE id_producto = $1
        RETURNING
          id_producto,
          nombre,
          activo
      `,
      [idProducto]
    );

    if (
      resultado.rows.length === 0
    ) {
      return res.status(404).json({
        ok: false,
        mensaje: 'Producto no encontrado',
      });
    }

    return res.json({
      ok: true,
      mensaje:
        'Producto desactivado correctamente',
      producto: resultado.rows[0],
    });
  } catch (error) {
    console.error(
      'Error al desactivar producto:',
      error
    );

    return res.status(500).json({
      ok: false,
      mensaje:
        'Error interno al desactivar producto',
    });
  }
};