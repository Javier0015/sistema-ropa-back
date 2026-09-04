import { pool } from '../config/db.js';

const ROLES_PERMITIDOS = new Set(['ROOT', 'SUPER_ADMIN', 'CAJERO']);

const redondearDos = (valor) => Number(Number(valor || 0).toFixed(2));

const esVerdadero = (valor) =>
  valor === true || valor === 'true' || valor === 1 || valor === '1';

const enteroPositivo = (valor) => {
  const numero = Number(valor);
  return Number.isInteger(numero) && numero > 0 ? numero : null;
};

const texto = (valor) => String(valor ?? '').trim();

const validarRol = (req, res) => {
  const rol = texto(req.usuario?.rol).toUpperCase();

  if (!ROLES_PERMITIDOS.has(rol)) {
    res.status(403).json({
      ok: false,
      mensaje: 'No tienes permiso para utilizar el módulo de cambios y devoluciones',
    });
    return false;
  }

  return true;
};

const esAdministradorGlobal = (usuario) => {
  const rol = texto(usuario?.rol).toUpperCase();
  return rol === 'ROOT' || rol === 'SUPER_ADMIN';
};

const generarFolioCambio = () => {
  const ahora = new Date();
  const yyyy = ahora.getFullYear();
  const mm = String(ahora.getMonth() + 1).padStart(2, '0');
  const dd = String(ahora.getDate()).padStart(2, '0');
  const hh = String(ahora.getHours()).padStart(2, '0');
  const mi = String(ahora.getMinutes()).padStart(2, '0');
  const ss = String(ahora.getSeconds()).padStart(2, '0');
  const random = Math.floor(Math.random() * 9000) + 1000;

  return `CAM-${yyyy}${mm}${dd}-${hh}${mi}${ss}-${random}`;
};

const nombreVariante = (fila = {}) => {
  const nombre = texto(fila.nombre_variante);
  if (nombre) return nombre;

  const atributos =
    fila.atributos && typeof fila.atributos === 'object' && !Array.isArray(fila.atributos)
      ? fila.atributos
      : {};

  const valores = [
    fila.talla,
    fila.color,
    fila.tono,
    fila.presentacion,
    ...Object.values(atributos),
  ]
    .map((valor) => texto(valor))
    .filter(Boolean);

  return [...new Set(valores)].join(' · ') || null;
};

const validarCajaYSesionActual = async ({
  client,
  usuario,
  idSucursal,
  idCaja,
  idSesion,
}) => {
  const idUsuario = enteroPositivo(usuario?.id_usuario);

  if (!idUsuario) {
    const error = new Error('No se pudo identificar al usuario autenticado');
    error.statusCode = 401;
    throw error;
  }

  const parametrosCaja = [idCaja, idSucursal];

  let consultaCaja = `
    SELECT
      c.id_caja,
      c.id_sucursal,
      c.nombre,
      c.id_usuario_asignado,
      c.activo
    FROM cajas c
    WHERE c.id_caja = $1
      AND c.id_sucursal = $2
      AND c.activo = true
  `;

  if (!esAdministradorGlobal(usuario)) {
    parametrosCaja.push(idUsuario);
    consultaCaja += ` AND c.id_usuario_asignado = $3 `;
  }

  consultaCaja += ' FOR UPDATE';

  const cajaResultado = await client.query(consultaCaja, parametrosCaja);

  if (cajaResultado.rows.length === 0) {
    const error = new Error(
      esAdministradorGlobal(usuario)
        ? 'La caja seleccionada no existe, está inactiva o no pertenece a la sucursal indicada'
        : 'Solo puedes realizar cambios desde la caja asignada a tu usuario'
    );
    error.statusCode = 403;
    throw error;
  }

  const sesionResultado = await client.query(
    `
    SELECT
      cs.id_sesion,
      cs.id_caja,
      cs.id_sucursal,
      cs.estado,
      cs.fecha_apertura
    FROM caja_sesiones cs
    WHERE cs.id_sesion = $1
      AND cs.id_caja = $2
      AND cs.id_sucursal = $3
      AND cs.estado = 'ABIERTA'
    FOR UPDATE
    `,
    [idSesion, idCaja, idSucursal]
  );

  if (sesionResultado.rows.length === 0) {
    const error = new Error(
      'La sesión de caja seleccionada no está abierta. Abre una caja antes de realizar el cambio.'
    );
    error.statusCode = 400;
    throw error;
  }

  return {
    caja: cajaResultado.rows[0],
    sesion: sesionResultado.rows[0],
  };
};

const obtenerCantidadProcesadaDetalle = async ({ client, idDetalle }) => {
  const resultado = await client.query(
    `
    SELECT COALESCE(SUM(cantidad), 0)::numeric(12,2) AS cantidad_procesada
    FROM (
      SELECT vdd.cantidad_devuelta AS cantidad
      FROM ventas_devoluciones_detalle vdd
      INNER JOIN ventas_devoluciones vd
        ON vd.id_devolucion = vdd.id_devolucion
      WHERE vdd.id_detalle = $1
        AND vd.estado = 'APLICADA'

      UNION ALL

      SELECT cde.cantidad
      FROM cambios_devoluciones_entrada cde
      INNER JOIN cambios_devoluciones cd
        ON cd.id_cambio = cde.id_cambio
      WHERE cde.id_detalle_venta = $1
        AND cd.estado = 'APLICADA'
    ) movimientos
    `,
    [idDetalle]
  );

  return Number(resultado.rows[0]?.cantidad_procesada || 0);
};

const actualizarInventarioGeneral = async ({
  client,
  idSucursal,
  idProducto,
  cantidad,
  operacion,
}) => {
  const inventarioResultado = await client.query(
    `
    SELECT
      id_inventario,
      id_variante,
      stock_actual
    FROM inventario_sucursal
    WHERE id_sucursal = $1
      AND id_producto = $2
    FOR UPDATE
    `,
    [idSucursal, idProducto]
  );

  if (inventarioResultado.rows.length === 0) {
    const error = new Error(`El producto ${idProducto} no tiene inventario en esta sucursal`);
    error.statusCode = 404;
    throw error;
  }

  const inventario = inventarioResultado.rows[0];
  const stockAnterior = Number(inventario.stock_actual || 0);
  const cantidadMovimiento = Number(cantidad || 0);
  const stockNuevo = redondearDos(
    operacion === 'SUMAR'
      ? stockAnterior + cantidadMovimiento
      : stockAnterior - cantidadMovimiento
  );

  if (stockNuevo < 0) {
    const error = new Error('Stock general insuficiente para completar el cambio');
    error.statusCode = 400;
    throw error;
  }

  await client.query(
    `
    UPDATE inventario_sucursal
    SET
      stock_actual = $1,
      fecha_actualizacion = CURRENT_TIMESTAMP
    WHERE id_inventario = $2
    `,
    [stockNuevo, inventario.id_inventario]
  );

  return {
    ...inventario,
    stock_anterior: stockAnterior,
    stock_nuevo: stockNuevo,
  };
};

const actualizarInventarioVariante = async ({
  client,
  idSucursal,
  idProducto,
  idVariante,
  cantidad,
  operacion,
}) => {
  const resultado = await client.query(
    `
    SELECT
      id_inventario_variante,
      stock_actual,
      activo
    FROM inventario_variantes_sucursal
    WHERE id_sucursal = $1
      AND id_producto = $2
      AND id_variante = $3
    FOR UPDATE
    `,
    [idSucursal, idProducto, idVariante]
  );

  if (resultado.rows.length === 0) {
    const error = new Error('La variante no tiene inventario en esta sucursal');
    error.statusCode = 404;
    throw error;
  }

  const registro = resultado.rows[0];
  const stockAnterior = Number(registro.stock_actual || 0);
  const cantidadMovimiento = Number(cantidad || 0);
  const stockNuevo = redondearDos(
    operacion === 'SUMAR'
      ? stockAnterior + cantidadMovimiento
      : stockAnterior - cantidadMovimiento
  );

  if (stockNuevo < 0) {
    const error = new Error('Stock insuficiente para la variante seleccionada');
    error.statusCode = 400;
    throw error;
  }

  await client.query(
    `
    UPDATE inventario_variantes_sucursal
    SET
      stock_actual = $1,
      activo = CASE WHEN $1::numeric > 0 THEN true ELSE activo END,
      fecha_actualizacion = CURRENT_TIMESTAMP
    WHERE id_inventario_variante = $2
    `,
    [stockNuevo, registro.id_inventario_variante]
  );

  return {
    stock_anterior: stockAnterior,
    stock_nuevo: stockNuevo,
  };
};

const obtenerLotesOriginales = async ({
  client,
  venta,
  detalle,
  cantidadProcesadaAnterior,
  cantidadSolicitada,
}) => {
  const parametros = [venta.folio, detalle.id_producto];

  let consulta = `
    SELECT
      im.id_lote,
      il.lote,
      SUM(im.cantidad)::numeric(12,2) AS cantidad_vendida,
      MIN(im.fecha_movimiento) AS primera_salida
    FROM inventario_movimientos im
    INNER JOIN inventario_lotes il
      ON il.id_lote = im.id_lote
    WHERE im.referencia = $1
      AND im.tipo_movimiento = 'VENTA'
      AND im.id_producto = $2
      AND im.id_lote IS NOT NULL
  `;

  if (esVerdadero(detalle.usa_variantes) && detalle.id_variante) {
    parametros.push(detalle.id_variante);
    consulta += ` AND im.id_variante = $${parametros.length} `;
  }

  consulta += `
    GROUP BY im.id_lote, il.lote
    ORDER BY
      CASE WHEN im.id_lote = ${detalle.id_lote ? Number(detalle.id_lote) : -1} THEN 0 ELSE 1 END,
      MIN(im.fecha_movimiento) ASC,
      im.id_lote ASC
  `;

  const resultado = await client.query(consulta, parametros);

  let lotes = resultado.rows.map((fila) => ({
    id_lote: Number(fila.id_lote),
    lote: fila.lote,
    cantidad_vendida: Number(fila.cantidad_vendida || 0),
  }));

  if (lotes.length === 0 && detalle.id_lote) {
    const fallback = await client.query(
      `
      SELECT id_lote, lote
      FROM inventario_lotes
      WHERE id_lote = $1
        AND id_sucursal = $2
        AND id_producto = $3
      FOR UPDATE
      `,
      [detalle.id_lote, venta.id_sucursal, detalle.id_producto]
    );

    if (fallback.rows.length > 0) {
      lotes = [
        {
          id_lote: Number(fallback.rows[0].id_lote),
          lote: fallback.rows[0].lote,
          cantidad_vendida: Number(detalle.cantidad || 0),
        },
      ];
    }
  }

  if (lotes.length === 0) {
    const error = new Error(
      `No fue posible identificar el lote original de ${detalle.producto}`
    );
    error.statusCode = 400;
    throw error;
  }

  let cantidadASaltar = Number(cantidadProcesadaAnterior || 0);
  let cantidadPendiente = Number(cantidadSolicitada || 0);
  const asignaciones = [];

  for (const lote of lotes) {
    let disponibleHistorico = Number(lote.cantidad_vendida || 0);

    if (cantidadASaltar > 0) {
      const consumidoPrevio = Math.min(cantidadASaltar, disponibleHistorico);
      disponibleHistorico -= consumidoPrevio;
      cantidadASaltar = redondearDos(cantidadASaltar - consumidoPrevio);
    }

    if (disponibleHistorico <= 0 || cantidadPendiente <= 0) continue;

    const cantidadLote = Math.min(disponibleHistorico, cantidadPendiente);

    asignaciones.push({
      id_lote: lote.id_lote,
      lote: lote.lote,
      cantidad: redondearDos(cantidadLote),
    });

    cantidadPendiente = redondearDos(cantidadPendiente - cantidadLote);
  }

  if (cantidadPendiente > 0.001) {
    const error = new Error(
      `No se pudo reconstruir completamente el lote original de ${detalle.producto}. Pendiente: ${cantidadPendiente}`
    );
    error.statusCode = 400;
    throw error;
  }

  return asignaciones;
};

const sumarStockLote = async ({ client, idLote, cantidad }) => {
  const loteResultado = await client.query(
    `
    SELECT id_lote, stock_actual
    FROM inventario_lotes
    WHERE id_lote = $1
    FOR UPDATE
    `,
    [idLote]
  );

  if (loteResultado.rows.length === 0) {
    const error = new Error(`No se encontró el lote ${idLote}`);
    error.statusCode = 404;
    throw error;
  }

  const stockAnterior = Number(loteResultado.rows[0].stock_actual || 0);
  const stockNuevo = redondearDos(stockAnterior + Number(cantidad || 0));

  await client.query(
    `
    UPDATE inventario_lotes
    SET
      stock_actual = $1,
      activo = true,
      fecha_actualizacion = CURRENT_TIMESTAMP
    WHERE id_lote = $2
    `,
    [stockNuevo, idLote]
  );

  return { stock_anterior: stockAnterior, stock_nuevo: stockNuevo };
};

const descontarLotesSalida = async ({
  client,
  idSucursal,
  idProducto,
  idVariante,
  usaVariantes,
  idLoteSolicitado,
  cantidad,
}) => {
  const parametros = [idSucursal, idProducto];

  let consulta = `
    SELECT
      id_lote,
      id_variante,
      lote,
      fecha_caducidad,
      stock_actual
    FROM inventario_lotes
    WHERE id_sucursal = $1
      AND id_producto = $2
      AND activo = true
      AND stock_actual > 0
  `;

  if (idLoteSolicitado) {
    parametros.push(idLoteSolicitado);
    consulta += ` AND id_lote = $${parametros.length} `;
  }

  if (usaVariantes) {
    parametros.push(idVariante);
    consulta += ` AND id_variante = $${parametros.length} `;
  }

  consulta += `
    ORDER BY fecha_caducidad ASC NULLS LAST, fecha_entrada ASC, id_lote ASC
    FOR UPDATE
  `;

  const resultado = await client.query(consulta, parametros);

  const stockTotal = resultado.rows.reduce(
    (acc, fila) => acc + Number(fila.stock_actual || 0),
    0
  );

  if (stockTotal + 0.001 < Number(cantidad || 0)) {
    const error = new Error('No hay stock suficiente por lotes para completar el cambio');
    error.statusCode = 400;
    throw error;
  }

  let pendiente = Number(cantidad || 0);
  const asignaciones = [];

  for (const lote of resultado.rows) {
    if (pendiente <= 0) break;

    const anterior = Number(lote.stock_actual || 0);
    const descontar = Math.min(anterior, pendiente);
    const nuevo = redondearDos(anterior - descontar);

    await client.query(
      `
      UPDATE inventario_lotes
      SET
        stock_actual = $1,
        activo = CASE WHEN $1::numeric <= 0 THEN false ELSE true END,
        fecha_actualizacion = CURRENT_TIMESTAMP
      WHERE id_lote = $2
      `,
      [nuevo, lote.id_lote]
    );

    asignaciones.push({
      id_lote: Number(lote.id_lote),
      id_variante: lote.id_variante ? Number(lote.id_variante) : null,
      lote: lote.lote,
      cantidad: redondearDos(descontar),
      stock_lote_anterior: anterior,
      stock_lote_nuevo: nuevo,
    });

    pendiente = redondearDos(pendiente - descontar);
  }

  return asignaciones;
};

const obtenerOfertaVigente = async ({ client, idCategoria }) => {
  if (!idCategoria) return null;

  const resultado = await client.query(
    `
    SELECT
      id_oferta,
      nombre,
      porcentaje_descuento
    FROM ofertas_categorias
    WHERE id_categoria = $1
      AND activo = true
      AND CURRENT_DATE BETWEEN fecha_inicio AND fecha_fin
    ORDER BY id_oferta DESC
    LIMIT 1
    `,
    [idCategoria]
  );

  return resultado.rows[0] || null;
};


export const listarVentasParaCambioPorFecha = async (req, res) => {
  if (!validarRol(req, res)) return;

  try {
    const idSucursal = enteroPositivo(req.query.sucursal);
    const fecha = texto(req.query.fecha);
    const idUsuario = enteroPositivo(req.usuario?.id_usuario);

    if (!idSucursal || !fecha) {
      return res.status(400).json({
        ok: false,
        mensaje: 'Sucursal y fecha son obligatorias',
      });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      return res.status(400).json({
        ok: false,
        mensaje: 'La fecha no tiene un formato válido',
      });
    }

    if (!esAdministradorGlobal(req.usuario) && !idUsuario) {
      return res.status(401).json({
        ok: false,
        mensaje: 'No se pudo identificar al usuario autenticado',
      });
    }

    const params = [idSucursal, fecha];

    let restriccionUsuario = '';

    if (!esAdministradorGlobal(req.usuario)) {
      params.push(idUsuario);
      restriccionUsuario = `
        AND EXISTS (
          SELECT 1
          FROM cajas caja_usuario
          WHERE caja_usuario.id_sucursal = v.id_sucursal
            AND caja_usuario.id_usuario_asignado = $${params.length}
            AND caja_usuario.activo = true
        )
      `;
    }

    const resultado = await pool.query(
      `
      SELECT
        v.id_venta,
        v.folio,
        v.id_sucursal,
        s.nombre AS sucursal,
        v.id_caja,
        c.nombre AS caja_original,
        v.id_sesion,
        v.id_usuario,
        u.nombre AS usuario_original,
        v.total,
        v.metodo_pago,
        v.estado,
        v.fecha_venta,
        COALESCE(detalle.cantidad_prendas, 0)::numeric(12,2) AS cantidad_prendas,
        COALESCE(detalle.productos, '[]'::jsonb) AS productos
      FROM ventas v
      INNER JOIN sucursales s
        ON s.id_sucursal = v.id_sucursal
      LEFT JOIN cajas c
        ON c.id_caja = v.id_caja
      INNER JOIN usuarios u
        ON u.id_usuario = v.id_usuario

      LEFT JOIN LATERAL (
        SELECT
          COALESCE(SUM(vd.cantidad), 0)::numeric(12,2) AS cantidad_prendas,
          COALESCE(
            jsonb_agg(
              jsonb_build_object(
                'id_detalle', vd.id_detalle,
                'id_producto', vd.id_producto,
                'id_variante', vd.id_variante,
                'producto', p.nombre,
                'codigo_barras', p.codigo_barras,
                'cantidad', vd.cantidad,
                'precio_unitario', vd.precio_unitario,
                'subtotal', vd.subtotal,
                'nombre_variante', pv.nombre_variante,
                'codigo_barras_variante', pv.codigo_barras,
                'sku_variante', pv.sku,
                'talla', pv.talla,
                'color', pv.color,
                'tono', pv.tono,
                'presentacion_variante', pv.presentacion,
                'atributos_variante', COALESCE(pv.atributos, '{}'::jsonb),
                'imagen_referencia', pv.imagen_referencia
              )
              ORDER BY vd.id_detalle ASC
            ) FILTER (WHERE vd.id_detalle IS NOT NULL),
            '[]'::jsonb
          ) AS productos
        FROM venta_detalle vd
        INNER JOIN productos p
          ON p.id_producto = vd.id_producto
        LEFT JOIN producto_variantes pv
          ON pv.id_variante = vd.id_variante
        WHERE vd.id_venta = v.id_venta
      ) detalle ON true

      WHERE v.id_sucursal = $1
        AND (
          v.fecha_venta AT TIME ZONE 'America/Mexico_City'
        )::date = $2::date
        AND UPPER(COALESCE(v.estado, '')) <> 'CANCELADA'
        ${restriccionUsuario}

      ORDER BY v.fecha_venta DESC, v.id_venta DESC
      LIMIT 300
      `,
      params
    );

    return res.json({
      ok: true,
      fecha,
      total: resultado.rows.length,
      ventas: resultado.rows,
    });
  } catch (error) {
    console.error('Error al listar ventas para cambio por fecha:', error);

    return res.status(500).json({
      ok: false,
      mensaje:
        error.message ||
        'Error interno al consultar las ventas del día',
    });
  }
};

export const buscarVentaParaCambio = async (req, res) => {
  if (!validarRol(req, res)) return;

  try {
    const idVenta = enteroPositivo(req.query.id_venta);
    const folio = texto(req.query.folio);
    const idSucursal = enteroPositivo(req.query.sucursal);
    const idUsuario = enteroPositivo(req.usuario?.id_usuario);

    if ((!idVenta && !folio) || !idSucursal) {
      return res.status(400).json({
        ok: false,
        mensaje: 'Debes indicar la venta y la sucursal',
      });
    }

    if (!esAdministradorGlobal(req.usuario) && !idUsuario) {
      return res.status(401).json({
        ok: false,
        mensaje: 'No se pudo identificar al usuario autenticado',
      });
    }

    const valorBusqueda = idVenta || folio;
    const params = [valorBusqueda, idSucursal];

    const condicionVenta = idVenta
      ? 'v.id_venta = $1'
      : 'UPPER(v.folio) = UPPER($1)';

    let restriccionUsuario = '';

    if (!esAdministradorGlobal(req.usuario)) {
      params.push(idUsuario);
      restriccionUsuario = `
        AND EXISTS (
          SELECT 1
          FROM cajas caja_usuario
          WHERE caja_usuario.id_sucursal = v.id_sucursal
            AND caja_usuario.id_usuario_asignado = $${params.length}
            AND caja_usuario.activo = true
        )
      `;
    }

    const ventaResultado = await pool.query(
      `
      SELECT
        v.id_venta,
        v.folio,
        v.id_sucursal,
        s.nombre AS sucursal,
        v.id_caja,
        c.nombre AS caja_original,
        v.id_sesion,
        v.id_usuario,
        u.nombre AS usuario_original,
        v.subtotal,
        v.descuento,
        v.impuesto,
        v.total,
        v.metodo_pago,
        v.estado,
        v.fecha_venta
      FROM ventas v
      INNER JOIN sucursales s
        ON s.id_sucursal = v.id_sucursal
      LEFT JOIN cajas c
        ON c.id_caja = v.id_caja
      INNER JOIN usuarios u
        ON u.id_usuario = v.id_usuario
      WHERE ${condicionVenta}
        AND v.id_sucursal = $2
        ${restriccionUsuario}
      LIMIT 1
      `,
      params
    );

    if (ventaResultado.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        mensaje:
          'No se encontró la venta en la sucursal seleccionada',
      });
    }

    const venta = ventaResultado.rows[0];

    if (texto(venta.estado).toUpperCase() === 'CANCELADA') {
      return res.status(400).json({
        ok: false,
        mensaje: 'No se pueden realizar cambios sobre una venta cancelada',
      });
    }

    const detalleResultado = await pool.query(
      `
      SELECT
        vd.id_detalle,
        vd.id_producto,
        vd.id_variante,
        vd.id_lote,
        p.nombre AS producto,
        p.codigo_barras,
        p.usa_variantes,
        p.controla_lotes,
        pv.nombre_variante,
        pv.sku AS sku_variante,
        pv.codigo_barras AS codigo_barras_variante,
        pv.talla,
        pv.color,
        pv.tono,
        pv.presentacion AS presentacion_variante,
        pv.imagen_referencia,
        COALESCE(pv.atributos, '{}'::jsonb) AS atributos_variante,
        il.lote,
        vd.cantidad,
        vd.precio_unitario,
        vd.precio_original,
        vd.subtotal,
        CASE
          WHEN COALESCE(vd.cantidad, 0) > 0 THEN
            ROUND(
              (vd.subtotal / vd.cantidad) *
              CASE
                WHEN COALESCE(v.subtotal, 0) > 0 THEN v.total / v.subtotal
                ELSE 1
              END,
              2
            )
          ELSE 0
        END AS precio_reconocido_unitario,
        COALESCE(procesado.cantidad_procesada, 0)::numeric(12,2) AS cantidad_procesada,
        GREATEST(
          COALESCE(vd.cantidad, 0) - COALESCE(procesado.cantidad_procesada, 0),
          0
        )::numeric(12,2) AS cantidad_disponible
      FROM venta_detalle vd
      INNER JOIN ventas v ON v.id_venta = vd.id_venta
      INNER JOIN productos p ON p.id_producto = vd.id_producto
      LEFT JOIN producto_variantes pv ON pv.id_variante = vd.id_variante
      LEFT JOIN inventario_lotes il ON il.id_lote = vd.id_lote
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(m.cantidad), 0)::numeric(12,2) AS cantidad_procesada
        FROM (
          SELECT vdd.cantidad_devuelta AS cantidad
          FROM ventas_devoluciones_detalle vdd
          INNER JOIN ventas_devoluciones vd2
            ON vd2.id_devolucion = vdd.id_devolucion
          WHERE vdd.id_detalle = vd.id_detalle
            AND vd2.estado = 'APLICADA'

          UNION ALL

          SELECT cde.cantidad
          FROM cambios_devoluciones_entrada cde
          INNER JOIN cambios_devoluciones cd
            ON cd.id_cambio = cde.id_cambio
          WHERE cde.id_detalle_venta = vd.id_detalle
            AND cd.estado = 'APLICADA'
        ) m
      ) procesado ON true
      WHERE vd.id_venta = $1
      ORDER BY vd.id_detalle ASC
      `,
      [venta.id_venta]
    );

    const historialResultado = await pool.query(
      `
      SELECT
        cd.id_cambio,
        cd.folio,
        cd.tipo_operacion,
        cd.valor_devuelto,
        cd.valor_nuevo,
        cd.diferencia_calculada,
        cd.tipo_movimiento_efectivo,
        cd.monto_efectivo,
        cd.estado,
        cd.fecha_movimiento,
        u.nombre AS usuario
      FROM cambios_devoluciones cd
      INNER JOIN usuarios u ON u.id_usuario = cd.id_usuario
      WHERE cd.id_venta_original = $1
      ORDER BY cd.fecha_movimiento DESC
      `,
      [venta.id_venta]
    );

    return res.json({
      ok: true,
      venta,
      productos: detalleResultado.rows,
      historial: historialResultado.rows,
    });
  } catch (error) {
    console.error('Error al buscar venta para cambio:', error);
    return res.status(500).json({
      ok: false,
      mensaje: error.message || 'Error interno al buscar la venta',
    });
  }
};

export const listarCambiosDevoluciones = async (req, res) => {
  if (!validarRol(req, res)) return;

  try {
    const idSucursal = enteroPositivo(req.query.sucursal);
    const limite = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);

    if (!idSucursal) {
      return res.status(400).json({
        ok: false,
        mensaje: 'La sucursal es obligatoria',
      });
    }

    const resultado = await pool.query(
      `
      SELECT
        cd.id_cambio,
        cd.folio,
        cd.id_venta_original,
        v.folio AS folio_venta,
        cd.tipo_operacion,
        cd.valor_devuelto,
        cd.valor_nuevo,
        cd.diferencia_calculada,
        cd.tipo_movimiento_efectivo,
        cd.monto_efectivo,
        cd.metodo_movimiento,
        cd.motivo,
        cd.observaciones,
        cd.estado,
        cd.fecha_movimiento,
        c.nombre AS caja,
        u.nombre AS usuario
      FROM cambios_devoluciones cd
      INNER JOIN ventas v ON v.id_venta = cd.id_venta_original
      INNER JOIN cajas c ON c.id_caja = cd.id_caja
      INNER JOIN usuarios u ON u.id_usuario = cd.id_usuario
      WHERE cd.id_sucursal = $1
      ORDER BY cd.fecha_movimiento DESC
      LIMIT $2
      `,
      [idSucursal, limite]
    );

    return res.json({ ok: true, movimientos: resultado.rows });
  } catch (error) {
    console.error('Error al listar cambios/devoluciones:', error);
    return res.status(500).json({
      ok: false,
      mensaje: 'Error interno al listar cambios y devoluciones',
    });
  }
};

export const crearCambioDevolucion = async (req, res) => {
  if (!validarRol(req, res)) return;

  const client = await pool.connect();

  try {
    const {
      id_sucursal,
      id_caja,
      id_sesion,
      id_venta_original,
      entradas = [],
      salidas = [],
      tipo_movimiento_efectivo,
      monto_efectivo,
      motivo,
      observaciones,
    } = req.body || {};

    const idSucursal = enteroPositivo(id_sucursal);
    const idCaja = enteroPositivo(id_caja);
    const idSesion = enteroPositivo(id_sesion);
    const idVenta = enteroPositivo(id_venta_original);

    if (!idSucursal || !idCaja || !idSesion || !idVenta) {
      return res.status(400).json({
        ok: false,
        mensaje: 'Sucursal, caja, sesión y venta original son obligatorias',
      });
    }

    if (!Array.isArray(entradas) || entradas.length === 0) {
      return res.status(400).json({
        ok: false,
        mensaje: 'Selecciona al menos una prenda que regresa el cliente',
      });
    }

    if (!Array.isArray(salidas)) {
      return res.status(400).json({
        ok: false,
        mensaje: 'Las prendas nuevas deben enviarse como arreglo',
      });
    }

    if (!texto(motivo)) {
      return res.status(400).json({
        ok: false,
        mensaje: 'El motivo del cambio/devolución es obligatorio',
      });
    }

    await client.query('BEGIN');

    await validarCajaYSesionActual({
      client,
      usuario: req.usuario,
      idSucursal,
      idCaja,
      idSesion,
    });

    const ventaResultado = await client.query(
      `
      SELECT
        id_venta,
        folio,
        id_sucursal,
        subtotal,
        total,
        estado,
        fecha_venta
      FROM ventas
      WHERE id_venta = $1
        AND id_sucursal = $2
      FOR UPDATE
      `,
      [idVenta, idSucursal]
    );

    if (ventaResultado.rows.length === 0) {
      const error = new Error(
        'La venta original no existe o pertenece a otra sucursal'
      );
      error.statusCode = 404;
      throw error;
    }

    const venta = ventaResultado.rows[0];

    if (texto(venta.estado).toUpperCase() === 'CANCELADA') {
      const error = new Error('No se puede cambiar una venta cancelada');
      error.statusCode = 400;
      throw error;
    }

    const folioCambio = generarFolioCambio();
    const idUsuario = enteroPositivo(req.usuario?.id_usuario);
    const tipoOperacion = salidas.length > 0 ? 'CAMBIO' : 'DEVOLUCION';

    const encabezadoResultado = await client.query(
      `
      INSERT INTO cambios_devoluciones (
        folio,
        id_venta_original,
        id_sucursal,
        id_caja,
        id_sesion,
        id_usuario,
        tipo_operacion,
        valor_devuelto,
        valor_nuevo,
        diferencia_calculada,
        tipo_movimiento_efectivo,
        monto_efectivo,
        metodo_movimiento,
        motivo,
        observaciones,
        estado
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,0,0,0,'SIN_MOVIMIENTO',0,'EFECTIVO',$8,$9,'APLICADA')
      RETURNING *
      `,
      [
        folioCambio,
        venta.id_venta,
        idSucursal,
        idCaja,
        idSesion,
        idUsuario,
        tipoOperacion,
        texto(motivo),
        texto(observaciones) || null,
      ]
    );

    const cambio = encabezadoResultado.rows[0];

    let valorDevuelto = 0;
    let valorNuevo = 0;
    const entradasGuardadas = [];
    const salidasGuardadas = [];

    for (const item of entradas) {
      const idDetalle = enteroPositivo(item?.id_detalle);
      const cantidad = Number(item?.cantidad || 0);
      const reintegrarStock = item?.reintegrar_stock !== false;

      if (!idDetalle || !Number.isFinite(cantidad) || cantidad <= 0) {
        const error = new Error(
          'Cada prenda devuelta debe incluir id_detalle y cantidad mayor a cero'
        );
        error.statusCode = 400;
        throw error;
      }

      const detalleResultado = await client.query(
        `
        SELECT
          vd.id_detalle,
          vd.id_venta,
          vd.id_producto,
          vd.id_variante,
          vd.id_lote,
          vd.cantidad,
          vd.subtotal,
          p.nombre AS producto,
          p.usa_variantes,
          p.controla_lotes,
          pv.nombre_variante,
          pv.talla,
          pv.color,
          pv.tono,
          pv.presentacion,
          COALESCE(pv.atributos, '{}'::jsonb) AS atributos,
          CASE
            WHEN COALESCE(vd.cantidad, 0) > 0 THEN
              ROUND(
                (vd.subtotal / vd.cantidad) *
                CASE
                  WHEN COALESCE(v.subtotal, 0) > 0 THEN v.total / v.subtotal
                  ELSE 1
                END,
                2
              )
            ELSE 0
          END AS precio_reconocido_unitario
        FROM venta_detalle vd
        INNER JOIN ventas v ON v.id_venta = vd.id_venta
        INNER JOIN productos p ON p.id_producto = vd.id_producto
        LEFT JOIN producto_variantes pv ON pv.id_variante = vd.id_variante
        WHERE vd.id_detalle = $1
          AND vd.id_venta = $2
        FOR UPDATE OF vd
        `,
        [idDetalle, venta.id_venta]
      );

      if (detalleResultado.rows.length === 0) {
        const error = new Error(`No existe el detalle de venta ${idDetalle}`);
        error.statusCode = 404;
        throw error;
      }

      const detalle = detalleResultado.rows[0];
      const cantidadProcesadaAnterior = await obtenerCantidadProcesadaDetalle({
        client,
        idDetalle,
      });

      const cantidadDisponible = redondearDos(
        Number(detalle.cantidad || 0) - cantidadProcesadaAnterior
      );

      if (cantidad > cantidadDisponible + 0.001) {
        const error = new Error(
          `No puedes procesar ${cantidad} de ${detalle.producto}. Disponible: ${cantidadDisponible}`
        );
        error.statusCode = 400;
        throw error;
      }

      const precioReconocido = redondearDos(detalle.precio_reconocido_unitario);
      const subtotalReconocido = redondearDos(precioReconocido * cantidad);
      valorDevuelto = redondearDos(valorDevuelto + subtotalReconocido);

      const varianteTexto = nombreVariante(detalle);
      let inventarioGeneral = null;
      let idVarianteMovimiento = detalle.id_variante
        ? Number(detalle.id_variante)
        : null;

      if (reintegrarStock) {
        inventarioGeneral = await actualizarInventarioGeneral({
          client,
          idSucursal,
          idProducto: detalle.id_producto,
          cantidad,
          operacion: 'SUMAR',
        });

        if (!idVarianteMovimiento && inventarioGeneral.id_variante) {
          idVarianteMovimiento = Number(inventarioGeneral.id_variante);
        }

        if (esVerdadero(detalle.usa_variantes)) {
          if (!detalle.id_variante) {
            const error = new Error(
              `La venta no conserva la variante de ${detalle.producto}`
            );
            error.statusCode = 400;
            throw error;
          }

          await actualizarInventarioVariante({
            client,
            idSucursal,
            idProducto: detalle.id_producto,
            idVariante: detalle.id_variante,
            cantidad,
            operacion: 'SUMAR',
          });
        }
      }

      if (reintegrarStock && esVerdadero(detalle.controla_lotes)) {
        const asignaciones = await obtenerLotesOriginales({
          client,
          venta,
          detalle,
          cantidadProcesadaAnterior,
          cantidadSolicitada: cantidad,
        });

        let acumuladoEntrada = 0;

        for (const asignacion of asignaciones) {
          await sumarStockLote({
            client,
            idLote: asignacion.id_lote,
            cantidad: asignacion.cantidad,
          });

          const subtotalParcial = redondearDos(
            precioReconocido * asignacion.cantidad
          );

          const entradaResultado = await client.query(
            `
            INSERT INTO cambios_devoluciones_entrada (
              id_cambio,
              id_venta_original,
              id_detalle_venta,
              id_producto,
              id_variante,
              id_lote,
              producto,
              variante,
              cantidad,
              precio_reconocido_unitario,
              subtotal_reconocido,
              reintegrado_stock
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true)
            RETURNING *
            `,
            [
              cambio.id_cambio,
              venta.id_venta,
              detalle.id_detalle,
              detalle.id_producto,
              detalle.id_variante || null,
              asignacion.id_lote,
              detalle.producto,
              varianteTexto,
              asignacion.cantidad,
              precioReconocido,
              subtotalParcial,
            ]
          );

          entradasGuardadas.push(entradaResultado.rows[0]);

          await client.query(
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
            VALUES ($1,$2,$3,$4,'CAMBIO_ENTRADA',$5,$6,$7,$8,$9,$10)
            `,
            [
              idSucursal,
              detalle.id_producto,
              idVarianteMovimiento,
              asignacion.id_lote,
              asignacion.cantidad,
              inventarioGeneral.stock_anterior,
              inventarioGeneral.stock_nuevo,
              folioCambio,
              `Entrada por ${tipoOperacion.toLowerCase()} ${folioCambio} de venta ${venta.folio}`,
              idUsuario,
            ]
          );

          acumuladoEntrada = redondearDos(acumuladoEntrada + asignacion.cantidad);
        }

        if (Math.abs(acumuladoEntrada - cantidad) > 0.01) {
          const error = new Error(`No se pudo reintegrar completamente ${detalle.producto}`);
          error.statusCode = 400;
          throw error;
        }
      } else {
        const entradaResultado = await client.query(
          `
          INSERT INTO cambios_devoluciones_entrada (
            id_cambio,
            id_venta_original,
            id_detalle_venta,
            id_producto,
            id_variante,
            id_lote,
            producto,
            variante,
            cantidad,
            precio_reconocido_unitario,
            subtotal_reconocido,
            reintegrado_stock
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          RETURNING *
          `,
          [
            cambio.id_cambio,
            venta.id_venta,
            detalle.id_detalle,
            detalle.id_producto,
            detalle.id_variante || null,
            detalle.id_lote || null,
            detalle.producto,
            varianteTexto,
            cantidad,
            precioReconocido,
            subtotalReconocido,
            reintegrarStock,
          ]
        );

        entradasGuardadas.push(entradaResultado.rows[0]);

        if (reintegrarStock) {
          await client.query(
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
            VALUES ($1,$2,$3,$4,'CAMBIO_ENTRADA',$5,$6,$7,$8,$9,$10)
            `,
            [
              idSucursal,
              detalle.id_producto,
              idVarianteMovimiento,
              detalle.id_lote || null,
              cantidad,
              inventarioGeneral.stock_anterior,
              inventarioGeneral.stock_nuevo,
              folioCambio,
              `Entrada por ${tipoOperacion.toLowerCase()} ${folioCambio} de venta ${venta.folio}`,
              idUsuario,
            ]
          );
        }
      }
    }

    for (const item of salidas) {
      const idProducto = enteroPositivo(item?.id_producto);
      const cantidad = Number(item?.cantidad || 0);
      const idVarianteSolicitada = enteroPositivo(item?.id_variante);
      const idLoteSolicitado = enteroPositivo(item?.id_lote);

      if (!idProducto || !Number.isFinite(cantidad) || cantidad <= 0) {
        const error = new Error(
          'Cada prenda nueva debe incluir id_producto y cantidad mayor a cero'
        );
        error.statusCode = 400;
        throw error;
      }

      const productoResultado = await client.query(
        `
        SELECT
          p.id_producto,
          p.id_categoria,
          p.nombre AS producto,
          p.precio_venta,
          p.usa_variantes,
          p.controla_lotes,
          i.id_inventario,
          i.id_variante AS id_variante_inventario,
          i.stock_actual
        FROM productos p
        INNER JOIN inventario_sucursal i
          ON i.id_producto = p.id_producto
         AND i.id_sucursal = $1
        WHERE p.id_producto = $2
          AND p.activo = true
        FOR UPDATE OF i
        `,
        [idSucursal, idProducto]
      );

      if (productoResultado.rows.length === 0) {
        const error = new Error(`El producto ${idProducto} no tiene inventario disponible`);
        error.statusCode = 404;
        throw error;
      }

      const producto = productoResultado.rows[0];
      const usaVariantes = esVerdadero(producto.usa_variantes);
      const controlaLotes = esVerdadero(producto.controla_lotes);
      let variante = null;
      let idVarianteMovimiento = producto.id_variante_inventario
        ? Number(producto.id_variante_inventario)
        : null;

      if (usaVariantes) {
        if (!idVarianteSolicitada) {
          const error = new Error(`Selecciona una variante para ${producto.producto}`);
          error.statusCode = 400;
          throw error;
        }

        const varianteResultado = await client.query(
          `
          SELECT
            ivs.id_inventario_variante,
            ivs.stock_actual,
            ivs.activo AS inventario_activo,
            pv.id_variante,
            pv.nombre_variante,
            pv.talla,
            pv.color,
            pv.tono,
            pv.presentacion,
            pv.precio_venta,
            COALESCE(pv.atributos, '{}'::jsonb) AS atributos,
            pv.activo AS variante_activa
          FROM inventario_variantes_sucursal ivs
          INNER JOIN producto_variantes pv ON pv.id_variante = ivs.id_variante
          WHERE ivs.id_sucursal = $1
            AND ivs.id_producto = $2
            AND ivs.id_variante = $3
          FOR UPDATE OF ivs
          `,
          [idSucursal, idProducto, idVarianteSolicitada]
        );

        if (varianteResultado.rows.length === 0) {
          const error = new Error(`La variante seleccionada de ${producto.producto} no existe`);
          error.statusCode = 404;
          throw error;
        }

        variante = varianteResultado.rows[0];

        if (!esVerdadero(variante.inventario_activo) || !esVerdadero(variante.variante_activa)) {
          const error = new Error(`La variante seleccionada de ${producto.producto} está inactiva`);
          error.statusCode = 400;
          throw error;
        }

        if (Number(variante.stock_actual || 0) + 0.001 < cantidad) {
          const error = new Error(`Stock insuficiente para la variante de ${producto.producto}`);
          error.statusCode = 400;
          throw error;
        }

        idVarianteMovimiento = Number(variante.id_variante);
      }

      if (Number(producto.stock_actual || 0) + 0.001 < cantidad) {
        const error = new Error(`Stock insuficiente para ${producto.producto}`);
        error.statusCode = 400;
        throw error;
      }

      const precioBase = redondearDos(
        usaVariantes && variante?.precio_venta !== null && variante?.precio_venta !== undefined
          ? variante.precio_venta
          : producto.precio_venta
      );

      const oferta = await obtenerOfertaVigente({
        client,
        idCategoria: producto.id_categoria,
      });

      const porcentajeDescuento = oferta
        ? redondearDos(oferta.porcentaje_descuento)
        : 0;

      const precioAplicado = redondearDos(
        precioBase - precioBase * (porcentajeDescuento / 100)
      );

      const subtotalSalida = redondearDos(precioAplicado * cantidad);
      valorNuevo = redondearDos(valorNuevo + subtotalSalida);

      const inventarioGeneral = await actualizarInventarioGeneral({
        client,
        idSucursal,
        idProducto,
        cantidad,
        operacion: 'RESTAR',
      });

      if (usaVariantes) {
        await actualizarInventarioVariante({
          client,
          idSucursal,
          idProducto,
          idVariante: idVarianteMovimiento,
          cantidad,
          operacion: 'RESTAR',
        });
      }

      const varianteTexto = nombreVariante(variante || {});

      if (controlaLotes) {
        const asignaciones = await descontarLotesSalida({
          client,
          idSucursal,
          idProducto,
          idVariante: idVarianteMovimiento,
          usaVariantes,
          idLoteSolicitado,
          cantidad,
        });

        for (const asignacion of asignaciones) {
          const subtotalParcial = redondearDos(
            precioAplicado * asignacion.cantidad
          );

          const salidaResultado = await client.query(
            `
            INSERT INTO cambios_devoluciones_salida (
              id_cambio,
              id_producto,
              id_variante,
              id_lote,
              producto,
              variante,
              cantidad,
              precio_unitario,
              subtotal,
              id_oferta,
              porcentaje_descuento
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            RETURNING *
            `,
            [
              cambio.id_cambio,
              idProducto,
              idVarianteMovimiento,
              asignacion.id_lote,
              producto.producto,
              varianteTexto,
              asignacion.cantidad,
              precioAplicado,
              subtotalParcial,
              oferta?.id_oferta || null,
              porcentajeDescuento,
            ]
          );

          salidasGuardadas.push(salidaResultado.rows[0]);

          await client.query(
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
            VALUES ($1,$2,$3,$4,'CAMBIO_SALIDA',$5,$6,$7,$8,$9,$10)
            `,
            [
              idSucursal,
              idProducto,
              idVarianteMovimiento,
              asignacion.id_lote,
              asignacion.cantidad,
              inventarioGeneral.stock_anterior,
              inventarioGeneral.stock_nuevo,
              folioCambio,
              `Salida de prenda por cambio ${folioCambio}`,
              idUsuario,
            ]
          );
        }
      } else {
        const salidaResultado = await client.query(
          `
          INSERT INTO cambios_devoluciones_salida (
            id_cambio,
            id_producto,
            id_variante,
            id_lote,
            producto,
            variante,
            cantidad,
            precio_unitario,
            subtotal,
            id_oferta,
            porcentaje_descuento
          )
          VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10)
          RETURNING *
          `,
          [
            cambio.id_cambio,
            idProducto,
            idVarianteMovimiento,
            producto.producto,
            varianteTexto,
            cantidad,
            precioAplicado,
            subtotalSalida,
            oferta?.id_oferta || null,
            porcentajeDescuento,
          ]
        );

        salidasGuardadas.push(salidaResultado.rows[0]);

        await client.query(
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
          VALUES ($1,$2,$3,NULL,'CAMBIO_SALIDA',$4,$5,$6,$7,$8,$9)
          `,
          [
            idSucursal,
            idProducto,
            idVarianteMovimiento,
            cantidad,
            inventarioGeneral.stock_anterior,
            inventarioGeneral.stock_nuevo,
            folioCambio,
            `Salida de prenda por cambio ${folioCambio}`,
            idUsuario,
          ]
        );
      }
    }

    const diferenciaCalculada = redondearDos(valorNuevo - valorDevuelto);

    let tipoEfectivo = texto(tipo_movimiento_efectivo).toUpperCase();
    let montoEfectivo =
      monto_efectivo === undefined || monto_efectivo === null || monto_efectivo === ''
        ? null
        : redondearDos(monto_efectivo);

    if (!['SIN_MOVIMIENTO', 'ENTRADA', 'SALIDA'].includes(tipoEfectivo)) {
      tipoEfectivo =
        diferenciaCalculada > 0
          ? 'ENTRADA'
          : diferenciaCalculada < 0
            ? 'SALIDA'
            : 'SIN_MOVIMIENTO';
    }

    if (montoEfectivo === null) {
      montoEfectivo =
        tipoEfectivo === 'SIN_MOVIMIENTO'
          ? 0
          : Math.abs(diferenciaCalculada);
    }

    if (!Number.isFinite(montoEfectivo) || montoEfectivo < 0) {
      const error = new Error('El monto de efectivo no es válido');
      error.statusCode = 400;
      throw error;
    }

    if (tipoEfectivo === 'SIN_MOVIMIENTO') {
      montoEfectivo = 0;
    }

    if (tipoEfectivo !== 'SIN_MOVIMIENTO' && montoEfectivo <= 0) {
      const error = new Error(
        'Captura un monto mayor a cero para el movimiento de efectivo'
      );
      error.statusCode = 400;
      throw error;
    }

    const cambioActualizadoResultado = await client.query(
      `
      UPDATE cambios_devoluciones
      SET
        valor_devuelto = $1,
        valor_nuevo = $2,
        diferencia_calculada = $3,
        tipo_movimiento_efectivo = $4,
        monto_efectivo = $5,
        metodo_movimiento = 'EFECTIVO'
      WHERE id_cambio = $6
      RETURNING *
      `,
      [
        valorDevuelto,
        valorNuevo,
        diferenciaCalculada,
        tipoEfectivo,
        montoEfectivo,
        cambio.id_cambio,
      ]
    );

    if (tipoEfectivo === 'ENTRADA' || tipoEfectivo === 'SALIDA') {
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
        VALUES ($1,$2,$3,$4,$5,'EFECTIVO',$6,$7,$8)
        `,
        [
          idSesion,
          idSucursal,
          tipoEfectivo,
          tipoEfectivo === 'ENTRADA'
            ? `Efectivo recibido en cambio ${folioCambio}`
            : `Efectivo entregado en cambio ${folioCambio}`,
          montoEfectivo,
          folioCambio,
          `Venta original ${venta.folio}. Diferencia calculada: ${diferenciaCalculada}. Motivo: ${texto(motivo)}`,
          idUsuario,
        ]
      );
    }

    await client.query('COMMIT');

    return res.status(201).json({
      ok: true,
      mensaje:
        tipoOperacion === 'CAMBIO'
          ? 'Cambio aplicado correctamente'
          : 'Devolución aplicada correctamente',
      movimiento: cambioActualizadoResultado.rows[0],
      venta_original: {
        id_venta: venta.id_venta,
        folio: venta.folio,
      },
      entradas: entradasGuardadas,
      salidas: salidasGuardadas,
      resumen: {
        valor_devuelto: valorDevuelto,
        valor_nuevo: valorNuevo,
        diferencia_calculada: diferenciaCalculada,
        tipo_movimiento_efectivo: tipoEfectivo,
        monto_efectivo: montoEfectivo,
      },
    });
  } catch (error) {
    await client.query('ROLLBACK');

    console.error('Error al crear cambio/devolución:', error);

    return res.status(error.statusCode || 500).json({
      ok: false,
      mensaje: error.message || 'Error interno al realizar el cambio/devolución',
    });
  } finally {
    client.release();
  }
};
