import { pool } from '../config/db.js';

const construirUrlImagen = (req, file) => {
  if (!file) return null;
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  return `${baseUrl}/uploads/catalogo/${file.filename}`;
};

const normalizarBooleano = (valor, defecto = false) => {
  if (valor === undefined || valor === null || valor === '') return defecto;
  if (typeof valor === 'boolean') return valor;
  const texto = String(valor).trim().toLowerCase();
  if (['true', '1', 'si', 'sí', 'on'].includes(texto)) return true;
  if (['false', '0', 'no', 'off'].includes(texto)) return false;
  return defecto;
};

const parsearJson = (valor, defecto) => {
  if (valor === undefined || valor === null || valor === '') return defecto;
  if (typeof valor === 'object') return valor;
  try {
    return JSON.parse(valor);
  } catch {
    return defecto;
  }
};

const obtenerArchivosCatalogo = (req) => {
  if (Array.isArray(req.files)) return req.files;
  if (req.files && typeof req.files === 'object') {
    return [
      ...(Array.isArray(req.files.imagenes) ? req.files.imagenes : []),
      ...(Array.isArray(req.files.imagen) ? req.files.imagen : []),
    ];
  }
  return req.file ? [req.file] : [];
};

const obtenerGaleriaSql = (aliasCatalogo = 'cp') => `
  LEFT JOIN LATERAL (
    SELECT
      jsonb_agg(
        jsonb_build_object(
          'id_imagen', cpi.id_imagen,
          'imagen_url', cpi.imagen_url,
          'orden', cpi.orden,
          'es_principal', cpi.es_principal,
          'activo', cpi.activo
        )
        ORDER BY cpi.es_principal DESC, cpi.orden ASC, cpi.id_imagen ASC
      ) AS imagenes,
      MAX(cpi.imagen_url) FILTER (WHERE cpi.es_principal = true) AS imagen_principal
    FROM public.catalogo_producto_imagenes cpi
    WHERE cpi.id_catalogo = ${aliasCatalogo}.id_catalogo
      AND cpi.activo = true
  ) galeria ON true
`;

const obtenerVariantesSql = (aliasProducto = 'p') => `
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
      jsonb_build_object(
        'id_variante', pv.id_variante,
        'sku', pv.sku,
        'codigo_barras', pv.codigo_barras,
        'nombre_variante', pv.nombre_variante,
        'talla', pv.talla,
        'color', pv.color,
        'tono', pv.tono,
        'presentacion', pv.presentacion,
        'precio_venta', COALESCE(pv.precio_venta, ${aliasProducto}.precio_venta),
        'es_principal', pv.es_principal,
        'atributos', pv.atributos,
        'stock_total', COALESCE(stock_variante.stock_total, 0)
      )
      ORDER BY pv.es_principal DESC, pv.id_variante ASC
    ) AS variantes
    FROM public.producto_variantes pv
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(i.stock_actual), 0) AS stock_total
      FROM public.inventario_sucursal i
      WHERE i.id_variante = pv.id_variante
    ) stock_variante ON true
    WHERE pv.id_producto = ${aliasProducto}.id_producto
      AND pv.activo = true
  ) variantes_data ON true
`;

const sincronizarGaleria = async ({ client, req, idCatalogo, esCreacion }) => {
  const archivos = obtenerArchivosCatalogo(req);
  const metadataRecibida = Object.prototype.hasOwnProperty.call(req.body || {}, 'metadata_galeria');
  let metadata = parsearJson(req.body?.metadata_galeria, null);

  if (!Array.isArray(metadata)) {
    metadata = archivos.map((_, indice) => ({
      tipo: 'nueva',
      archivo_index: indice,
      orden: indice,
      es_principal: indice === 0,
    }));
  }

  if (!esCreacion && metadataRecibida) {
    const idsConservados = metadata
      .filter((item) => item?.tipo === 'existente' && Number(item?.id_imagen) > 0)
      .map((item) => Number(item.id_imagen));

    if (idsConservados.length > 0) {
      await client.query(
        `
          DELETE FROM public.catalogo_producto_imagenes
          WHERE id_catalogo = $1
            AND NOT (id_imagen = ANY($2::int[]))
        `,
        [idCatalogo, idsConservados]
      );
    } else {
      await client.query(
        `DELETE FROM public.catalogo_producto_imagenes WHERE id_catalogo = $1`,
        [idCatalogo]
      );
    }
  }

  await client.query(
    `
      UPDATE public.catalogo_producto_imagenes
      SET es_principal = false
      WHERE id_catalogo = $1
    `,
    [idCatalogo]
  );

  for (let indice = 0; indice < metadata.length; indice += 1) {
    const item = metadata[indice] || {};
    const orden = Number.isFinite(Number(item.orden)) ? Number(item.orden) : indice;
    const esPrincipal = normalizarBooleano(item.es_principal, false);

    if (item.tipo === 'existente' && Number(item.id_imagen) > 0) {
      await client.query(
        `
          UPDATE public.catalogo_producto_imagenes
          SET
            orden = $1,
            es_principal = $2,
            activo = true
          WHERE id_imagen = $3
            AND id_catalogo = $4
        `,
        [orden, esPrincipal, Number(item.id_imagen), idCatalogo]
      );
      continue;
    }

    if (item.tipo === 'legacy') {
      const urlLegacy = String(item.imagen_url || '').trim();
      if (!urlLegacy) continue;

      const existe = await client.query(
        `
          SELECT id_imagen
          FROM public.catalogo_producto_imagenes
          WHERE id_catalogo = $1
            AND imagen_url = $2
          LIMIT 1
        `,
        [idCatalogo, urlLegacy]
      );

      if (existe.rows.length > 0) {
        await client.query(
          `
            UPDATE public.catalogo_producto_imagenes
            SET orden = $1, es_principal = $2, activo = true
            WHERE id_imagen = $3
          `,
          [orden, esPrincipal, existe.rows[0].id_imagen]
        );
      } else {
        await client.query(
          `
            INSERT INTO public.catalogo_producto_imagenes (
              id_catalogo,
              imagen_url,
              orden,
              es_principal,
              activo
            )
            VALUES ($1, $2, $3, $4, true)
          `,
          [idCatalogo, urlLegacy, orden, esPrincipal]
        );
      }
      continue;
    }

    if (item.tipo === 'nueva') {
      const archivoIndex = Number(item.archivo_index);
      const archivo = archivos[archivoIndex];
      if (!archivo) continue;
      const url = construirUrlImagen(req, archivo);

      await client.query(
        `
          INSERT INTO public.catalogo_producto_imagenes (
            id_catalogo,
            imagen_url,
            orden,
            es_principal,
            activo
          )
          VALUES ($1, $2, $3, $4, true)
        `,
        [idCatalogo, url, orden, esPrincipal]
      );
    }
  }

  const principal = await client.query(
    `
      SELECT id_imagen, imagen_url
      FROM public.catalogo_producto_imagenes
      WHERE id_catalogo = $1
        AND activo = true
        AND es_principal = true
      ORDER BY orden ASC, id_imagen ASC
      LIMIT 1
    `,
    [idCatalogo]
  );

  let imagenPrincipal = principal.rows[0] || null;

  if (!imagenPrincipal) {
    const primera = await client.query(
      `
        SELECT id_imagen, imagen_url
        FROM public.catalogo_producto_imagenes
        WHERE id_catalogo = $1
          AND activo = true
        ORDER BY orden ASC, id_imagen ASC
        LIMIT 1
      `,
      [idCatalogo]
    );

    if (primera.rows.length > 0) {
      imagenPrincipal = primera.rows[0];
      await client.query(
        `UPDATE public.catalogo_producto_imagenes SET es_principal = true WHERE id_imagen = $1`,
        [imagenPrincipal.id_imagen]
      );
    }
  }

  await client.query(
    `
      UPDATE public.catalogo_productos
      SET imagen_url = $1,
          fecha_actualizacion = NOW()
      WHERE id_catalogo = $2
    `,
    [imagenPrincipal?.imagen_url || null, idCatalogo]
  );
};

export const listarCatalogoAdmin = async (req, res) => {
  try {
    const query = `
      SELECT
        cp.id_catalogo,
        cp.id_producto,
        cp.titulo_catalogo,
        cp.descripcion_catalogo,
        COALESCE(galeria.imagen_principal, cp.imagen_url) AS imagen_url,
        cp.activo,
        cp.destacado,
        cp.mostrar_stock,
        cp.orden,
        cp.fecha_creacion,
        cp.fecha_actualizacion,
        p.codigo_barras,
        p.nombre AS nombre_producto,
        p.descripcion AS descripcion_producto,
        p.id_marca,
        m.nombre AS marca,
        p.presentacion,
        p.precio_venta,
        p.usa_variantes,
        p.controla_lotes,
        p.controla_caducidad,
        c.nombre AS nombre_categoria,
        COALESCE(inv.stock_total, 0) AS stock_total,
        COALESCE(
          galeria.imagenes,
          CASE
            WHEN cp.imagen_url IS NOT NULL THEN jsonb_build_array(
              jsonb_build_object(
                'id_imagen', NULL,
                'imagen_url', cp.imagen_url,
                'orden', 0,
                'es_principal', true,
                'activo', true,
                'legacy', true
              )
            )
            ELSE '[]'::jsonb
          END
        ) AS imagenes,
        COALESCE(variantes_data.variantes, '[]'::jsonb) AS variantes,
        oc.id_oferta,
        oc.nombre AS nombre_oferta,
        oc.descripcion AS descripcion_oferta,
        oc.porcentaje_descuento,
        (oc.id_oferta IS NOT NULL) AS tiene_oferta,
        CASE
          WHEN oc.id_oferta IS NOT NULL THEN
            ROUND(p.precio_venta - (p.precio_venta * oc.porcentaje_descuento / 100), 2)
          ELSE p.precio_venta
        END AS precio_final
      FROM public.catalogo_productos cp
      INNER JOIN public.productos p ON p.id_producto = cp.id_producto
      LEFT JOIN public.categorias c ON c.id_categoria = p.id_categoria
      LEFT JOIN public.marcas m ON m.id_marca = p.id_marca
      LEFT JOIN LATERAL (
        SELECT oc2.id_oferta, oc2.nombre, oc2.descripcion, oc2.porcentaje_descuento
        FROM public.ofertas_categorias oc2
        WHERE oc2.id_categoria = p.id_categoria
          AND oc2.activo = true
          AND CURRENT_DATE BETWEEN oc2.fecha_inicio AND oc2.fecha_fin
        ORDER BY oc2.fecha_creacion DESC
        LIMIT 1
      ) oc ON true
      LEFT JOIN (
        SELECT id_producto, SUM(stock_actual) AS stock_total
        FROM public.inventario_sucursal
        GROUP BY id_producto
      ) inv ON inv.id_producto = p.id_producto
      ${obtenerGaleriaSql('cp')}
      ${obtenerVariantesSql('p')}
      ORDER BY cp.orden ASC, cp.fecha_creacion DESC
    `;

    const { rows } = await pool.query(query);
    return res.json({ ok: true, catalogo: rows });
  } catch (error) {
    console.error('Error al listar catálogo admin:', error);
    return res.status(500).json({
      ok: false,
      mensaje: 'Error al listar el catálogo',
      error: error.message,
    });
  }
};

export const listarProductosParaCatalogo = async (req, res) => {
  try {
    const query = `
      SELECT
        p.id_producto,
        p.codigo_barras,
        p.nombre,
        p.descripcion,
        p.id_marca,
        m.nombre AS marca,
        p.presentacion,
        p.precio_venta,
        p.id_categoria,
        p.usa_variantes,
        p.controla_lotes,
        p.controla_caducidad,
        c.nombre AS nombre_categoria,
        COALESCE(inv.stock_total, 0) AS stock_total,
        COALESCE(variantes_data.variantes, '[]'::jsonb) AS variantes,
        (cp.id_catalogo IS NOT NULL) AS ya_en_catalogo,
        cp.id_catalogo
      FROM public.productos p
      LEFT JOIN public.categorias c ON c.id_categoria = p.id_categoria
      LEFT JOIN public.marcas m ON m.id_marca = p.id_marca
      LEFT JOIN (
        SELECT id_producto, SUM(stock_actual) AS stock_total
        FROM public.inventario_sucursal
        GROUP BY id_producto
      ) inv ON inv.id_producto = p.id_producto
      LEFT JOIN public.catalogo_productos cp ON cp.id_producto = p.id_producto
      ${obtenerVariantesSql('p')}
      WHERE p.activo = true
      ORDER BY p.nombre ASC
    `;

    const { rows } = await pool.query(query);
    return res.json({ ok: true, productos: rows });
  } catch (error) {
    console.error('Error al listar productos para catálogo:', error);
    return res.status(500).json({
      ok: false,
      mensaje: 'Error al listar productos para catálogo',
      error: error.message,
    });
  }
};

export const crearProductoCatalogo = async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      id_producto,
      titulo_catalogo,
      descripcion_catalogo,
      activo,
      destacado,
      mostrar_stock,
      orden,
    } = req.body;

    const idProducto = Number(id_producto);
    if (!Number.isInteger(idProducto) || idProducto <= 0) {
      return res.status(400).json({ ok: false, mensaje: 'El producto es obligatorio' });
    }

    await client.query('BEGIN');

    const productoExiste = await client.query(
      `SELECT id_producto FROM public.productos WHERE id_producto = $1 AND activo = true LIMIT 1`,
      [idProducto]
    );

    if (productoExiste.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, mensaje: 'El producto no existe o está inactivo' });
    }

    const creado = await client.query(
      `
        INSERT INTO public.catalogo_productos (
          id_producto,
          titulo_catalogo,
          descripcion_catalogo,
          imagen_url,
          activo,
          destacado,
          mostrar_stock,
          orden
        )
        VALUES ($1, $2, $3, NULL, $4, $5, $6, $7)
        RETURNING *
      `,
      [
        idProducto,
        String(titulo_catalogo || '').trim() || null,
        String(descripcion_catalogo || '').trim() || null,
        normalizarBooleano(activo, true),
        normalizarBooleano(destacado, false),
        normalizarBooleano(mostrar_stock, true),
        Number(orden || 0),
      ]
    );

    await sincronizarGaleria({
      client,
      req,
      idCatalogo: creado.rows[0].id_catalogo,
      esCreacion: true,
    });

    const final = await client.query(
      `SELECT * FROM public.catalogo_productos WHERE id_catalogo = $1`,
      [creado.rows[0].id_catalogo]
    );

    await client.query('COMMIT');

    return res.status(201).json({
      ok: true,
      mensaje: 'Producto agregado al catálogo correctamente',
      producto: final.rows[0],
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Error al crear producto de catálogo:', error);
    if (error.code === '23505') {
      return res.status(400).json({ ok: false, mensaje: 'Este producto ya está agregado al catálogo' });
    }
    return res.status(500).json({
      ok: false,
      mensaje: 'Error al crear producto de catálogo',
      error: error.message,
    });
  } finally {
    client.release();
  }
};

export const actualizarProductoCatalogo = async (req, res) => {
  const client = await pool.connect();
  try {
    const idCatalogo = Number(req.params.id);
    if (!Number.isInteger(idCatalogo) || idCatalogo <= 0) {
      return res.status(400).json({ ok: false, mensaje: 'El identificador del producto de catálogo no es válido' });
    }

    const {
      titulo_catalogo,
      descripcion_catalogo,
      activo,
      destacado,
      mostrar_stock,
      orden,
    } = req.body;

    await client.query('BEGIN');

    const actualizado = await client.query(
      `
        UPDATE public.catalogo_productos
        SET
          titulo_catalogo = $1,
          descripcion_catalogo = $2,
          activo = $3,
          destacado = $4,
          mostrar_stock = $5,
          orden = $6,
          fecha_actualizacion = NOW()
        WHERE id_catalogo = $7
        RETURNING *
      `,
      [
        String(titulo_catalogo || '').trim() || null,
        String(descripcion_catalogo || '').trim() || null,
        normalizarBooleano(activo, true),
        normalizarBooleano(destacado, false),
        normalizarBooleano(mostrar_stock, true),
        Number(orden || 0),
        idCatalogo,
      ]
    );

    if (actualizado.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, mensaje: 'Producto del catálogo no encontrado' });
    }

    if (
      Object.prototype.hasOwnProperty.call(req.body || {}, 'metadata_galeria') ||
      obtenerArchivosCatalogo(req).length > 0
    ) {
      await sincronizarGaleria({ client, req, idCatalogo, esCreacion: false });
    }

    const final = await client.query(
      `SELECT * FROM public.catalogo_productos WHERE id_catalogo = $1`,
      [idCatalogo]
    );

    await client.query('COMMIT');

    return res.json({
      ok: true,
      mensaje: 'Producto del catálogo actualizado correctamente',
      producto: final.rows[0],
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Error al actualizar producto de catálogo:', error);
    return res.status(500).json({
      ok: false,
      mensaje: 'Error al actualizar producto de catálogo',
      error: error.message,
    });
  } finally {
    client.release();
  }
};

export const cambiarEstadoProductoCatalogo = async (req, res) => {
  try {
    const idCatalogo = Number(req.params.id);
    const activo = normalizarBooleano(req.body?.activo, false);

    const { rows } = await pool.query(
      `
        UPDATE public.catalogo_productos
        SET activo = $1, fecha_actualizacion = NOW()
        WHERE id_catalogo = $2
        RETURNING *
      `,
      [activo, idCatalogo]
    );

    if (rows.length === 0) {
      return res.status(404).json({ ok: false, mensaje: 'Producto del catálogo no encontrado' });
    }

    return res.json({
      ok: true,
      mensaje: activo ? 'Producto activado en catálogo' : 'Producto desactivado del catálogo',
      producto: rows[0],
    });
  } catch (error) {
    console.error('Error al cambiar estado del producto de catálogo:', error);
    return res.status(500).json({ ok: false, mensaje: 'Error al cambiar estado del producto', error: error.message });
  }
};

export const eliminarProductoCatalogo = async (req, res) => {
  try {
    const idCatalogo = Number(req.params.id);
    const { rows } = await pool.query(
      `DELETE FROM public.catalogo_productos WHERE id_catalogo = $1 RETURNING *`,
      [idCatalogo]
    );

    if (rows.length === 0) {
      return res.status(404).json({ ok: false, mensaje: 'Producto del catálogo no encontrado' });
    }

    return res.json({
      ok: true,
      mensaje: 'Producto eliminado del catálogo correctamente',
      producto: rows[0],
    });
  } catch (error) {
    console.error('Error al eliminar producto de catálogo:', error);
    return res.status(500).json({ ok: false, mensaje: 'Error al eliminar producto del catálogo', error: error.message });
  }
};

const convertirBooleano = (valor, valorPorDefecto = false) => {
  if (typeof valor === 'boolean') return valor;

  if (typeof valor === 'string') {
    const texto = valor.trim().toLowerCase();

    if (['true', '1', 'on', 'si', 'sí'].includes(texto)) return true;
    if (['false', '0', 'off', 'no'].includes(texto)) return false;
  }

  if (typeof valor === 'number') {
    return valor === 1;
  }

  return valorPorDefecto;
};

const normalizarUrlRedSocial = (url) => {
  const valor = String(url || '').trim();

  if (!valor) return null;

  let urlValidada;

  try {
    urlValidada = new URL(valor);
  } catch {
    throw new Error('El enlace no tiene un formato válido.');
  }

  if (!['http:', 'https:'].includes(urlValidada.protocol)) {
    throw new Error('El enlace debe iniciar con http:// o https://');
  }

  return urlValidada.toString();
};

/*
 * Convierte números mexicanos capturados como 7711234567, 52 771 123 4567
 * o 5217711234567 al formato internacional que utiliza wa.me: 527711234567.
 */
const normalizarTelefonoWhatsApp = (telefono) => {
  let digitos = String(telefono || '').replace(/\D/g, '');

  if (!digitos) return null;

  if (digitos.startsWith('521') && digitos.length === 13) {
    digitos = `52${digitos.slice(3)}`;
  }

  if (digitos.startsWith('52') && digitos.length === 12) {
    return digitos;
  }

  if (digitos.length === 10) {
    return `52${digitos}`;
  }

  return null;
};

/* =========================================================
   ADMINISTRACIÓN: devuelve todas las redes del catálogo
========================================================= */
export const listarRedesSocialesCatalogo = async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        id_red_social,
        clave,
        nombre,
        url,
        activo,
        orden,
        fecha_creacion,
        fecha_actualizacion
      FROM public.catalogo_redes_sociales
      ORDER BY orden ASC, nombre ASC
    `);

    return res.json({
      ok: true,
      redes_sociales: rows,
    });
  } catch (error) {
    console.error('Error al listar redes sociales del catálogo:', error);

    return res.status(500).json({
      ok: false,
      mensaje: 'No se pudieron cargar las redes sociales.',
    });
  }
};

/* =========================================================
   ADMINISTRACIÓN: sucursales configurables desde Catálogo
========================================================= */
export const listarSucursalesWhatsappCatalogo = async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        id_sucursal,
        nombre,
        clave,
        direccion,
        telefono,
        url_google_maps,
        activo,
        mostrar_whatsapp_catalogo
      FROM public.sucursales
      ORDER BY activo DESC, nombre ASC
    `);

    const sucursales = rows.map((sucursal) => {
      const telefonoWhatsapp = normalizarTelefonoWhatsApp(sucursal.telefono);

      return {
        ...sucursal,
        telefono_valido: Boolean(telefonoWhatsapp),
        telefono_whatsapp: telefonoWhatsapp,
      };
    });

    return res.json({
      ok: true,
      sucursales: sucursales,
    });
  } catch (error) {
    console.error('Error al listar sucursales para WhatsApp del catálogo:', error);

    return res.status(500).json({
      ok: false,
      mensaje: 'No se pudieron cargar las sucursales para WhatsApp.',
    });
  }
};

/* =========================================================
   ADMINISTRACIÓN: muestra u oculta una sucursal en WhatsApp
========================================================= */
export const actualizarSucursalWhatsappCatalogo = async (req, res) => {
  try {
    const idSucursal = Number(req.params.id);
    const mostrarWhatsapp = convertirBooleano(
      req.body?.mostrar_whatsapp_catalogo,
      false
    );

    if (!Number.isInteger(idSucursal) || idSucursal <= 0) {
      return res.status(400).json({
        ok: false,
        mensaje: 'El identificador de la sucursal no es válido.',
      });
    }

    const { rows: sucursales } = await pool.query(
      `
      SELECT
        id_sucursal,
        nombre,
        telefono,
        url_google_maps,
        activo
      FROM public.sucursales
      WHERE id_sucursal = $1
      `,
      [idSucursal]
    );

    if (sucursales.length === 0) {
      return res.status(404).json({
        ok: false,
        mensaje: 'La sucursal no fue encontrada.',
      });
    }

    const sucursal = sucursales[0];
    const telefonoWhatsapp = normalizarTelefonoWhatsApp(sucursal.telefono);

    if (mostrarWhatsapp && !sucursal.activo) {
      return res.status(400).json({
        ok: false,
        mensaje: 'No puedes mostrar una sucursal inactiva en WhatsApp.',
      });
    }

    if (mostrarWhatsapp && !telefonoWhatsapp) {
      return res.status(400).json({
        ok: false,
        mensaje:
          'La sucursal requiere un teléfono mexicano válido de 10 dígitos para mostrarse en WhatsApp.',
      });
    }

    const { rows } = await pool.query(
      `
      UPDATE public.sucursales
      SET
        mostrar_whatsapp_catalogo = $1,
        fecha_actualizacion = CURRENT_TIMESTAMP
      WHERE id_sucursal = $2
      RETURNING
        id_sucursal,
        nombre,
        clave,
        direccion,
        telefono,
        activo,
        mostrar_whatsapp_catalogo,
        fecha_actualizacion
      `,
      [mostrarWhatsapp, idSucursal]
    );

    const actualizado = rows[0];

    return res.json({
      ok: true,
      mensaje: mostrarWhatsapp
        ? 'Sucursal disponible en WhatsApp del catálogo.'
        : 'Sucursal oculta de WhatsApp del catálogo.',
      sucursal: {
        ...actualizado,
        telefono_valido: Boolean(
          normalizarTelefonoWhatsApp(actualizado.telefono)
        ),
      },
    });
  } catch (error) {
    console.error('Error al actualizar sucursal para WhatsApp del catálogo:', error);

    return res.status(500).json({
      ok: false,
      mensaje: 'No se pudo actualizar la sucursal para WhatsApp.',
    });
  }
};

/* =========================================================
   ADMINISTRACIÓN: actualiza enlace, visibilidad y orden
========================================================= */
export const actualizarRedSocialCatalogo = async (req, res) => {
  try {
    const idRedSocial = Number(req.params.id);
    const { url, activo, orden } = req.body;

    if (!Number.isInteger(idRedSocial) || idRedSocial <= 0) {
      return res.status(400).json({
        ok: false,
        mensaje: 'El identificador de la red social no es válido.',
      });
    }

    const { rows: existentes } = await pool.query(
      `
      SELECT id_red_social, clave
      FROM public.catalogo_redes_sociales
      WHERE id_red_social = $1
      `,
      [idRedSocial]
    );

    if (existentes.length === 0) {
      return res.status(404).json({
        ok: false,
        mensaje: 'La red social no fue encontrada.',
      });
    }

    const clave = String(existentes[0].clave || '').toUpperCase();
    const esWhatsapp = clave === 'WHATSAPP';

    let urlNormalizada = null;

    if (!esWhatsapp) {
      try {
        urlNormalizada = normalizarUrlRedSocial(url);
      } catch (errorUrl) {
        return res.status(400).json({
          ok: false,
          mensaje: errorUrl.message,
        });
      }
    }

    const activoNormalizado = convertirBooleano(activo, false);
    const ordenNormalizado =
      orden === '' || orden === null || orden === undefined
        ? 0
        : Number(orden);

    if (!Number.isInteger(ordenNormalizado) || ordenNormalizado < 0) {
      return res.status(400).json({
        ok: false,
        mensaje: 'El orden debe ser un número entero mayor o igual a cero.',
      });
    }

    if (activoNormalizado && !esWhatsapp && !urlNormalizada) {
      return res.status(400).json({
        ok: false,
        mensaje:
          'Para mostrar una red social en el catálogo debes capturar un enlace válido.',
      });
    }

    const { rows } = await pool.query(
      `
      UPDATE public.catalogo_redes_sociales
      SET
        url = $1,
        activo = $2,
        orden = $3,
        fecha_actualizacion = CURRENT_TIMESTAMP
      WHERE id_red_social = $4
      RETURNING
        id_red_social,
        clave,
        nombre,
        url,
        activo,
        orden,
        fecha_creacion,
        fecha_actualizacion
      `,
      [
        esWhatsapp ? null : urlNormalizada,
        activoNormalizado,
        ordenNormalizado,
        idRedSocial,
      ]
    );

    return res.json({
      ok: true,
      mensaje: 'Red social actualizada correctamente.',
      red_social: rows[0],
    });
  } catch (error) {
    console.error('Error al actualizar red social del catálogo:', error);

    return res.status(500).json({
      ok: false,
      mensaje: 'No se pudo actualizar la red social.',
    });
  }
};

/* =========================================================
   PÚBLICO: redes visibles. WhatsApp depende de sucursales
========================================================= */
export const listarRedesSocialesPublicas = async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        rs.clave,
        rs.nombre,
        rs.url,
        rs.activo,
        rs.orden
      FROM public.catalogo_redes_sociales rs
      WHERE rs.activo = true
        AND (
          (
            rs.clave = 'WHATSAPP'
            AND EXISTS (
              SELECT 1
              FROM public.sucursales s
              WHERE s.activo = true
                AND s.mostrar_whatsapp_catalogo = true
                AND NULLIF(BTRIM(s.telefono), '') IS NOT NULL
            )
          )
          OR (
            rs.clave <> 'WHATSAPP'
            AND NULLIF(BTRIM(rs.url), '') IS NOT NULL
          )
        )
      ORDER BY rs.orden ASC, rs.nombre ASC
    `);

    return res.json({
      ok: true,
      redes_sociales: rows,
    });
  } catch (error) {
    console.error('Error al listar redes sociales públicas:', error);

    return res.status(500).json({
      ok: false,
      mensaje: 'No se pudieron cargar las redes sociales públicas.',
    });
  }
};

/* =========================================================
   PÚBLICO: sucursales visibles en el selector de WhatsApp
========================================================= */
export const listarSucursalesWhatsappPublicas = async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        id_sucursal,
        nombre,
        clave,
        direccion,
        url_google_maps,
        telefono
      FROM public.sucursales
      WHERE activo = true
        AND mostrar_whatsapp_catalogo = true
        AND NULLIF(BTRIM(telefono), '') IS NOT NULL
      ORDER BY nombre ASC
    `);

    const sucursales = rows
      .map((sucursal) => {
        const telefonoWhatsapp = normalizarTelefonoWhatsApp(sucursal.telefono);

        if (!telefonoWhatsapp) return null;

        const mensaje = encodeURIComponent(
          `Hola.`
        );

        return {
          ...sucursal,
          telefono_whatsapp: telefonoWhatsapp,
          url_whatsapp: `https://wa.me/${telefonoWhatsapp}?text=${mensaje}`,
        };
      })
      .filter(Boolean);

    return res.json({
      ok: true,
      sucursales: sucursales,
    });
  } catch (error) {
    console.error('Error al listar sucursales públicas para WhatsApp:', error);

    return res.status(500).json({
      ok: false,
      mensaje: 'No se pudieron cargar las sucursales para WhatsApp.',
    });
  }
};
