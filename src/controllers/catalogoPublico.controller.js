import { pool } from '../config/db.js';

const obtenerLimiteAutocomplete = (valor, limitePorDefecto = 8) => {
  const limite = Number(valor || limitePorDefecto);
  if (!Number.isInteger(limite)) return limitePorDefecto;
  return Math.min(Math.max(limite, 1), 10);
};

const JOIN_STOCK_PUBLICO = `
  LEFT JOIN (
    SELECT
      i.id_producto,
      COALESCE(SUM(GREATEST(COALESCE(i.stock_actual, 0), 0)), 0) AS stock_total
    FROM public.inventario_sucursal i
    INNER JOIN public.sucursales s ON s.id_sucursal = i.id_sucursal
    WHERE s.activo = true
    GROUP BY i.id_producto
  ) inv ON inv.id_producto = p.id_producto
`;

const JOIN_SUCURSALES_DISPONIBLES = `
  LEFT JOIN (
    SELECT
      disponibilidad.id_producto,
      COUNT(*)::int AS total_sucursales_disponibles,
      jsonb_agg(
        jsonb_build_object(
          'id_sucursal', disponibilidad.id_sucursal,
          'nombre', disponibilidad.nombre,
          'clave', disponibilidad.clave,
          'direccion', disponibilidad.direccion,
          'telefono', disponibilidad.telefono,
          'url_google_maps', disponibilidad.url_google_maps
        )
        ORDER BY disponibilidad.nombre ASC
      ) AS sucursales_disponibles
    FROM (
      SELECT
        i.id_producto,
        s.id_sucursal,
        s.nombre,
        s.clave,
        s.direccion,
        s.telefono,
        s.url_google_maps
      FROM public.inventario_sucursal i
      INNER JOIN public.sucursales s ON s.id_sucursal = i.id_sucursal
      WHERE i.stock_actual > 0
        AND s.activo = true
      GROUP BY
        i.id_producto,
        s.id_sucursal,
        s.nombre,
        s.clave,
        s.direccion,
        s.telefono,
        s.url_google_maps
    ) disponibilidad
    GROUP BY disponibilidad.id_producto
  ) sucursales_disponibles ON sucursales_disponibles.id_producto = p.id_producto
`;

const JOIN_GALERIA = `
  LEFT JOIN LATERAL (
    SELECT
      jsonb_agg(
        jsonb_build_object(
          'id_imagen', cpi.id_imagen,
          'imagen_url', cpi.imagen_url,
          'orden', cpi.orden,
          'es_principal', cpi.es_principal
        )
        ORDER BY cpi.es_principal DESC, cpi.orden ASC, cpi.id_imagen ASC
      ) AS imagenes,
      MAX(cpi.imagen_url) FILTER (WHERE cpi.es_principal = true) AS imagen_principal
    FROM public.catalogo_producto_imagenes cpi
    WHERE cpi.id_catalogo = cp.id_catalogo
      AND cpi.activo = true
  ) galeria ON true
`;

const JOIN_VARIANTES = `
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
        'precio_venta', COALESCE(pv.precio_venta, p.precio_venta),
        'precio_final', CASE
          WHEN oc.id_oferta IS NOT NULL THEN ROUND(
            COALESCE(pv.precio_venta, p.precio_venta) -
            (COALESCE(pv.precio_venta, p.precio_venta) * oc.porcentaje_descuento / 100),
            2
          )
          ELSE COALESCE(pv.precio_venta, p.precio_venta)
        END,
        'es_principal', pv.es_principal,
        'atributos', pv.atributos,
        'stock_total', COALESCE(stock_variante.stock_total, 0),
        'disponible', COALESCE(stock_variante.stock_total, 0) > 0
      )
      ORDER BY pv.es_principal DESC, pv.id_variante ASC
    ) AS variantes
    FROM public.producto_variantes pv
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(i.stock_actual), 0) AS stock_total
      FROM public.inventario_sucursal i
      INNER JOIN public.sucursales s ON s.id_sucursal = i.id_sucursal
      WHERE i.id_variante = pv.id_variante
        AND s.activo = true
    ) stock_variante ON true
    WHERE pv.id_producto = p.id_producto
      AND pv.activo = true
  ) variantes_data ON true
`;

const SELECT_BASE = `
  cp.id_catalogo,
  cp.id_producto,
  cp.titulo_catalogo,
  cp.descripcion_catalogo,
  COALESCE(galeria.imagen_principal, cp.imagen_url) AS imagen_url,
  cp.destacado,
  cp.mostrar_stock,
  cp.orden,
  p.codigo_barras,
  p.nombre AS nombre_producto,
  p.descripcion AS descripcion_producto,
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
  COALESCE(sucursales_disponibles.total_sucursales_disponibles, 0) AS total_sucursales_disponibles,
  COALESCE(sucursales_disponibles.sucursales_disponibles, '[]'::jsonb) AS sucursales_disponibles,
  COALESCE(
    galeria.imagenes,
    CASE
      WHEN cp.imagen_url IS NOT NULL THEN jsonb_build_array(
        jsonb_build_object(
          'id_imagen', NULL,
          'imagen_url', cp.imagen_url,
          'orden', 0,
          'es_principal', true
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
`;

const FROM_BASE = `
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
  ${JOIN_STOCK_PUBLICO}
  ${JOIN_SUCURSALES_DISPONIBLES}
  ${JOIN_GALERIA}
  ${JOIN_VARIANTES}
`;

export const listarCatalogoPublico = async (req, res) => {
  try {
    const { q, categoria, id_catalogo: idCatalogo, autocomplete, limit } = req.query;

    if (autocomplete === '1' || autocomplete === 'true') {
      const texto = String(q || '').trim();
      if (texto.length < 2) {
        return res.json({ ok: true, productos: [] });
      }

      const params = [texto, `%${texto}%`];
      let filtroCategoria = '';

      if (categoria) {
        const idCategoria = Number(categoria);
        if (Number.isInteger(idCategoria) && idCategoria > 0) {
          params.push(idCategoria);
          filtroCategoria = ` AND p.id_categoria = $${params.length} `;
        }
      }

      params.push(obtenerLimiteAutocomplete(limit));
      const indiceLimite = params.length;

      const queryAutocomplete = `
        SELECT
          cp.id_catalogo,
          cp.id_producto,
          cp.titulo_catalogo,
          COALESCE(galeria.imagen_principal, cp.imagen_url) AS imagen_url,
          p.codigo_barras,
          p.nombre AS nombre_producto,
          m.nombre AS marca,
          p.presentacion,
          p.precio_venta,
          c.nombre AS nombre_categoria,
          oc.porcentaje_descuento,
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
          SELECT oc2.id_oferta, oc2.porcentaje_descuento
          FROM public.ofertas_categorias oc2
          WHERE oc2.id_categoria = p.id_categoria
            AND oc2.activo = true
            AND CURRENT_DATE BETWEEN oc2.fecha_inicio AND oc2.fecha_fin
          ORDER BY oc2.fecha_creacion DESC
          LIMIT 1
        ) oc ON true
        ${JOIN_GALERIA}
        WHERE cp.activo = true
          AND p.activo = true
          AND (
            p.nombre ILIKE $2
            OR COALESCE(p.descripcion, '') ILIKE $2
            OR COALESCE(p.codigo_barras, '') ILIKE $2
            OR COALESCE(m.nombre, '') ILIKE $2
            OR COALESCE(p.presentacion, '') ILIKE $2
            OR COALESCE(cp.titulo_catalogo, '') ILIKE $2
            OR EXISTS (
              SELECT 1
              FROM public.producto_variantes pv
              WHERE pv.id_producto = p.id_producto
                AND pv.activo = true
                AND (
                  COALESCE(pv.sku, '') ILIKE $2
                  OR COALESCE(pv.codigo_barras, '') ILIKE $2
                  OR COALESCE(pv.talla, '') ILIKE $2
                  OR COALESCE(pv.color, '') ILIKE $2
                  OR COALESCE(pv.tono, '') ILIKE $2
                  OR COALESCE(pv.presentacion, '') ILIKE $2
                )
            )
          )
          ${filtroCategoria}
        ORDER BY
          CASE
            WHEN p.codigo_barras ILIKE $1 THEN 0
            WHEN COALESCE(cp.titulo_catalogo, p.nombre) ILIKE $1 THEN 1
            WHEN p.nombre ILIKE $1 THEN 2
            ELSE 3
          END,
          cp.destacado DESC,
          cp.orden ASC,
          p.nombre ASC
        LIMIT $${indiceLimite}
      `;

      const { rows } = await pool.query(queryAutocomplete, params);
      return res.json({ ok: true, productos: rows });
    }

    const params = [];
    let whereExtra = '';

    if (idCatalogo !== undefined && idCatalogo !== '') {
      const idCatalogoNumerico = Number(idCatalogo);
      if (!Number.isInteger(idCatalogoNumerico) || idCatalogoNumerico <= 0) {
        return res.status(400).json({ ok: false, mensaje: 'El producto seleccionado no es válido.' });
      }
      params.push(idCatalogoNumerico);
      whereExtra += ` AND cp.id_catalogo = $${params.length} `;
    }

    if (q) {
      params.push(`%${String(q).trim()}%`);
      whereExtra += `
        AND (
          p.nombre ILIKE $${params.length}
          OR COALESCE(p.descripcion, '') ILIKE $${params.length}
          OR COALESCE(m.nombre, '') ILIKE $${params.length}
          OR COALESCE(p.presentacion, '') ILIKE $${params.length}
          OR COALESCE(cp.titulo_catalogo, '') ILIKE $${params.length}
          OR EXISTS (
            SELECT 1
            FROM public.producto_variantes pv
            WHERE pv.id_producto = p.id_producto
              AND pv.activo = true
              AND (
                COALESCE(pv.sku, '') ILIKE $${params.length}
                OR COALESCE(pv.talla, '') ILIKE $${params.length}
                OR COALESCE(pv.color, '') ILIKE $${params.length}
                OR COALESCE(pv.tono, '') ILIKE $${params.length}
                OR COALESCE(pv.presentacion, '') ILIKE $${params.length}
              )
          )
        )
      `;
    }

    if (categoria) {
      const idCategoria = Number(categoria);
      if (Number.isInteger(idCategoria) && idCategoria > 0) {
        params.push(idCategoria);
        whereExtra += ` AND p.id_categoria = $${params.length} `;
      }
    }

    const query = `
      SELECT ${SELECT_BASE}
      ${FROM_BASE}
      WHERE cp.activo = true
        AND p.activo = true
        ${whereExtra}
      ORDER BY cp.destacado DESC, cp.orden ASC, p.nombre ASC
    `;

    const { rows } = await pool.query(query, params);
    return res.json({ ok: true, catalogo: rows });
  } catch (error) {
    console.error('Error al listar catálogo público:', error);
    return res.status(500).json({
      ok: false,
      mensaje: 'Error al listar catálogo público',
      error: error.message,
    });
  }
};

export const obtenerDetalleProductoPublico = async (req, res) => {
  try {
    const idCatalogo = Number(req.params.id);
    if (!Number.isInteger(idCatalogo) || idCatalogo <= 0) {
      return res.status(400).json({ ok: false, mensaje: 'El producto seleccionado no es válido.' });
    }

    const query = `
      SELECT ${SELECT_BASE}
      ${FROM_BASE}
      WHERE cp.id_catalogo = $1
        AND cp.activo = true
        AND p.activo = true
      LIMIT 1
    `;

    const { rows } = await pool.query(query, [idCatalogo]);
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, mensaje: 'Producto no encontrado en catálogo' });
    }

    return res.json({ ok: true, producto: rows[0] });
  } catch (error) {
    console.error('Error al obtener detalle público:', error);
    return res.status(500).json({
      ok: false,
      mensaje: 'Error al obtener detalle del producto',
      error: error.message,
    });
  }
};

export const listarCategoriasCatalogoPublico = async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT c.id_categoria, c.nombre
      FROM public.catalogo_productos cp
      INNER JOIN public.productos p ON p.id_producto = cp.id_producto
      INNER JOIN public.categorias c ON c.id_categoria = p.id_categoria
      WHERE cp.activo = true
        AND p.activo = true
        AND c.activo = true
      ORDER BY c.nombre ASC
    `);

    return res.json({ ok: true, categorias: rows });
  } catch (error) {
    console.error('Error al listar categorías públicas:', error);
    return res.status(500).json({
      ok: false,
      mensaje: 'Error al listar categorías del catálogo',
      error: error.message,
    });
  }
};
