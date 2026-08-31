import { pool } from '../config/db.js';
import { enviarTicketDigitalVenta } from '../services/ticketDigitalCorreo.service.js';

const esSuperAdmin = (usuario) => {
  return String(usuario?.rol || '').trim().toUpperCase() === 'SUPER_ADMIN';
};

const obtenerIdUsuarioAutenticado = (usuario) => {
  const idUsuario = Number(usuario?.id_usuario);

  return Number.isInteger(idUsuario) && idUsuario > 0
    ? idUsuario
    : null;
};

/*
 * Un SUPER_ADMIN puede operar cualquier caja activa.
 * Cualquier otro usuario solo puede operar la caja activa que tenga asignada
 * en cajas.id_usuario_asignado.
 */
const validarAccesoCajaAsignada = async ({
  db,
  usuario,
  idCaja,
  idSucursal = null,
  bloquear = false,
}) => {
  const idCajaNumerico = Number(idCaja);
  const idSucursalNumerico =
    idSucursal === null || idSucursal === undefined || idSucursal === ''
      ? null
      : Number(idSucursal);

  if (!Number.isInteger(idCajaNumerico) || idCajaNumerico <= 0) {
    return {
      ok: false,
      status: 400,
      mensaje: 'La caja seleccionada no es válida',
    };
  }

  if (
    idSucursalNumerico !== null &&
    (!Number.isInteger(idSucursalNumerico) || idSucursalNumerico <= 0)
  ) {
    return {
      ok: false,
      status: 400,
      mensaje: 'La sucursal seleccionada no es válida',
    };
  }

  const esAdmin = esSuperAdmin(usuario);
  const idUsuario = obtenerIdUsuarioAutenticado(usuario);

  if (!esAdmin && !idUsuario) {
    return {
      ok: false,
      status: 401,
      mensaje: 'No se pudo identificar al usuario de la sesión',
    };
  }

  const params = [idCajaNumerico];

  let query = `
    SELECT
      c.id_caja,
      c.id_sucursal,
      c.nombre,
      c.activo,
      c.id_usuario_asignado
    FROM cajas c
    WHERE c.id_caja = $1
      AND c.activo = true
  `;

  if (idSucursalNumerico !== null) {
    params.push(idSucursalNumerico);
    query += ` AND c.id_sucursal = $${params.length}`;
  }

  if (!esAdmin) {
    params.push(idUsuario);
    query += ` AND c.id_usuario_asignado = $${params.length}`;
  }

  query += ' LIMIT 1';

  if (bloquear) {
    query += ' FOR UPDATE';
  }

  const resultado = await db.query(query, params);

  if (resultado.rows.length === 0) {
    return {
      ok: false,
      status: 403,
      mensaje: esAdmin
        ? 'La caja seleccionada no existe, está inactiva o no pertenece a la sucursal indicada'
        : 'No tienes permiso para operar esta caja. Solo puedes usar la caja asignada a tu usuario.',
    };
  }

  return {
    ok: true,
    caja: resultado.rows[0],
  };
};

const responderAccesoCajaDenegado = (res, acceso) => {
  return res.status(acceso.status || 403).json({
    ok: false,
    mensaje: acceso.mensaje || 'No tienes permiso para operar esta caja',
  });
};


const generarFolioVenta = () => {
  const fecha = new Date();

  const yyyy = fecha.getFullYear();
  const mm = String(fecha.getMonth() + 1).padStart(2, '0');
  const dd = String(fecha.getDate()).padStart(2, '0');
  const hh = String(fecha.getHours()).padStart(2, '0');
  const mi = String(fecha.getMinutes()).padStart(2, '0');
  const ss = String(fecha.getSeconds()).padStart(2, '0');
  const random = Math.floor(Math.random() * 9000) + 1000;

  return `V-${yyyy}${mm}${dd}-${hh}${mi}${ss}-${random}`;
};

const generarFolioDevolucion = () => {
  const fecha = new Date();

  const yyyy = fecha.getFullYear();
  const mm = String(fecha.getMonth() + 1).padStart(2, '0');
  const dd = String(fecha.getDate()).padStart(2, '0');
  const hh = String(fecha.getHours()).padStart(2, '0');
  const mi = String(fecha.getMinutes()).padStart(2, '0');
  const ss = String(fecha.getSeconds()).padStart(2, '0');
  const random = Math.floor(Math.random() * 9000) + 1000;

  return `DEV-${yyyy}${mm}${dd}-${hh}${mi}${ss}-${random}`;
};

const estadosVentaConDevolucionPermitida = [
  'COMPLETADA',
  'DEVUELTA_PARCIAL',
];

const redondearDos = (valor) => {
  return Number(Number(valor || 0).toFixed(2));
};

const esValorActivo = (valor) => {
  return valor === true || valor === 'true' || valor === 1 || valor === '1';
};

const METODOS_PAGO_PERMITIDOS = [
  'EFECTIVO',
  'TARJETA',
  'TRANSFERENCIA',
  'PUNTOS',
  'MIXTO',
];

const METODOS_PAGO_DETALLE_PERMITIDOS = [
  'EFECTIVO',
  'TARJETA',
  'TRANSFERENCIA',
  'PUNTOS',
];

const normalizarPagosMixtos = (pagos = []) => {
  const acumulado = {
    EFECTIVO: 0,
    TARJETA: 0,
    TRANSFERENCIA: 0,
    PUNTOS: 0,
  };

  if (!Array.isArray(pagos)) {
    return {
      ok: false,
      mensaje: 'Los pagos de una venta mixta deben enviarse como arreglo',
      pagos: [],
      acumulado,
    };
  }

  for (const pago of pagos) {
    const metodo = String(pago?.metodo_pago || '').trim().toUpperCase();
    const monto = redondearDos(pago?.monto || 0);

    if (!metodo) continue;

    if (!METODOS_PAGO_DETALLE_PERMITIDOS.includes(metodo)) {
      return {
        ok: false,
        mensaje: `Método de pago mixto no válido: ${metodo}`,
        pagos: [],
        acumulado,
      };
    }

    if (monto < 0) {
      return {
        ok: false,
        mensaje: 'Los montos de pago no pueden ser negativos',
        pagos: [],
        acumulado,
      };
    }

    if (monto > 0) {
      acumulado[metodo] = redondearDos(acumulado[metodo] + monto);
    }
  }

  const pagosNormalizados = Object.entries(acumulado)
    .filter(([, monto]) => Number(monto || 0) > 0)
    .map(([metodo_pago, monto]) => ({
      metodo_pago,
      monto: redondearDos(monto),
    }));

  return {
    ok: true,
    mensaje: null,
    pagos: pagosNormalizados,
    acumulado,
  };
};

const descontarLotesFEFO = async ({
  client,
  id_sucursal,
  id_producto,
  id_variante = null,
  usaVariantes = false,
  cantidadVenta,
}) => {
  let cantidadPendiente = Number(cantidadVenta);

  const params = [id_sucursal, id_producto];

  let query = `
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

  // Si el producto realmente usa variantes, el lote sí debe pertenecer a la
  // variante seleccionada. Para productos sin variantes no filtramos por
  // id_variante, porque hay inventario histórico migrado con una variante
  // principal aunque el producto actualmente no utilice variantes.
  if (usaVariantes) {
    params.push(id_variante);
    query += ` AND id_variante IS NOT DISTINCT FROM $${params.length}::integer `;
  }

  query += `
    ORDER BY
      fecha_caducidad ASC NULLS LAST,
      fecha_entrada ASC,
      id_lote ASC
    FOR UPDATE
  `;

  const lotesResultado = await client.query(query, params);

  const stockTotalLotes = lotesResultado.rows.reduce((acc, lote) => {
    return acc + Number(lote.stock_actual || 0);
  }, 0);

  if (stockTotalLotes < cantidadPendiente) {
    return {
      ok: false,
      mensaje: 'No hay stock suficiente por lotes para completar la venta',
      stock_lotes: stockTotalLotes,
      cantidad_solicitada: cantidadVenta,
      lotes_descontados: [],
    };
  }

  const lotesDescontados = [];

  for (const loteItem of lotesResultado.rows) {
    if (cantidadPendiente <= 0) break;

    const stockLoteAnterior = Number(loteItem.stock_actual);
    const cantidadADescontar = Math.min(stockLoteAnterior, cantidadPendiente);
    const stockLoteNuevo = stockLoteAnterior - cantidadADescontar;

    await client.query(
      `
      UPDATE inventario_lotes
      SET
        stock_actual = $1::numeric,
        activo = CASE WHEN $1::numeric <= 0::numeric THEN false ELSE true END,
        fecha_actualizacion = CURRENT_TIMESTAMP
      WHERE id_lote = $2
      `,
      [stockLoteNuevo, loteItem.id_lote]
    );

    lotesDescontados.push({
      id_lote: loteItem.id_lote,
      id_variante: loteItem.id_variante || null,
      lote: loteItem.lote,
      fecha_caducidad: loteItem.fecha_caducidad,
      cantidad_descontada: cantidadADescontar,
      stock_lote_anterior: stockLoteAnterior,
      stock_lote_nuevo: stockLoteNuevo,
    });

    cantidadPendiente -= cantidadADescontar;
  }

  return {
    ok: true,
    lotes_descontados: lotesDescontados,
  };
};

const descontarLoteSeleccionado = async ({
  client,
  id_sucursal,
  id_producto,
  id_variante = null,
  usaVariantes = false,
  id_lote,
  cantidadVenta,
}) => {
  const cantidadADescontar = Number(cantidadVenta);

  const params = [id_lote, id_sucursal, id_producto];

  let query = `
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
  `;

  // Para productos con variantes mantenemos la validación estricta.
  // Para productos sin variantes basta validar que el lote corresponda al
  // producto y a la sucursal; esto permite vender lotes históricos que
  // conservaron id_variante después de la migración.
  if (usaVariantes) {
    params.push(id_variante);
    query += ` AND id_variante IS NOT DISTINCT FROM $${params.length}::integer `;
  }

  query += ` FOR UPDATE `;

  const loteResultado = await client.query(query, params);

  if (loteResultado.rows.length === 0) {
    return {
      ok: false,
      mensaje:
        'El lote seleccionado no existe o no pertenece al producto/sucursal',
      lotes_descontados: [],
    };
  }

  const loteItem = loteResultado.rows[0];

  if (!loteItem.activo) {
    return {
      ok: false,
      mensaje: `El lote ${loteItem.lote} está inactivo`,
      lotes_descontados: [],
    };
  }

  const stockLoteAnterior = Number(loteItem.stock_actual || 0);

  if (stockLoteAnterior <= 0) {
    return {
      ok: false,
      mensaje: `El lote ${loteItem.lote} no tiene stock disponible`,
      stock_lote: stockLoteAnterior,
      cantidad_solicitada: cantidadADescontar,
      lotes_descontados: [],
    };
  }

  if (stockLoteAnterior < cantidadADescontar) {
    return {
      ok: false,
      mensaje: `Stock insuficiente en el lote ${loteItem.lote}`,
      stock_lote: stockLoteAnterior,
      cantidad_solicitada: cantidadADescontar,
      lotes_descontados: [],
    };
  }

  const stockLoteNuevo = stockLoteAnterior - cantidadADescontar;

  await client.query(
    `
    UPDATE inventario_lotes
    SET
      stock_actual = $1::numeric,
      activo = CASE WHEN $1::numeric <= 0::numeric THEN false ELSE true END,
      fecha_actualizacion = CURRENT_TIMESTAMP
    WHERE id_lote = $2
    `,
    [stockLoteNuevo, loteItem.id_lote]
  );

  return {
    ok: true,
    lotes_descontados: [
      {
        id_lote: loteItem.id_lote,
        id_variante: loteItem.id_variante || null,
        lote: loteItem.lote,
        fecha_caducidad: loteItem.fecha_caducidad,
        cantidad_descontada: cantidadADescontar,
        stock_lote_anterior: stockLoteAnterior,
        stock_lote_nuevo: stockLoteNuevo,
      },
    ],
  };
};

const obtenerConfiguracionPuntos = async (client) => {
  const resultado = await client.query(
    `
    SELECT
      id_configuracion,
      porcentaje_cliente,
      porcentaje_cajero,
      puntos_cliente_activo,
      puntos_cajero_activo
    FROM configuracion_puntos
    ORDER BY id_configuracion DESC
    LIMIT 1
    `
  );

  if (resultado.rows.length > 0) {
    return resultado.rows[0];
  }

  const creada = await client.query(
    `
    INSERT INTO configuracion_puntos (
      porcentaje_cliente,
      porcentaje_cajero,
      puntos_cliente_activo,
      puntos_cajero_activo
    )
    VALUES (1.00, 0.50, true, true)
    RETURNING
      id_configuracion,
      porcentaje_cliente,
      porcentaje_cajero,
      puntos_cliente_activo,
      puntos_cajero_activo
    `
  );

  return creada.rows[0];
};

const calcularPuntosPorcentaje = ({ total, porcentaje, activo }) => {
  if (!esValorActivo(activo)) return 0;

  const totalNumerico = Number(total || 0);
  const porcentajeNumerico = Number(porcentaje || 0);

  if (totalNumerico <= 0 || porcentajeNumerico <= 0) return 0;

  return redondearDos(totalNumerico * (porcentajeNumerico / 100));
};

const validarOfertaProducto = async ({
  client,
  idOferta,
  idProducto,
  idCategoriaProducto,
}) => {
  if (!idOferta) return null;

  const ofertaResultado = await client.query(
    `
    SELECT
      oc.id_oferta,
      oc.id_categoria,
      oc.nombre,
      oc.porcentaje_descuento,
      oc.fecha_inicio,
      oc.fecha_fin,
      oc.activo
    FROM ofertas_categorias oc
    WHERE oc.id_oferta = $1
      AND oc.id_categoria = $2
      AND oc.activo = true
      AND CURRENT_DATE BETWEEN oc.fecha_inicio AND oc.fecha_fin
    LIMIT 1
    `,
    [idOferta, idCategoriaProducto]
  );

  if (ofertaResultado.rows.length === 0) {
    throw new Error(
      `La oferta enviada para el producto ${idProducto} no existe, no está vigente o no pertenece a su categoría`
    );
  }

  return ofertaResultado.rows[0];
};

export const crearVenta = async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      id_sucursal,
      id_caja,
      id_sesion,
      metodo_pago,
      monto_recibido,
      pagos = [],
      descuento = 0,
      impuesto = 0,
      productos = [],
      id_tarjeta_puntos,
      enviar_ticket_digital = false,
    } = req.body;

    if (!id_sucursal || !id_caja || !id_sesion) {
      return res.status(400).json({
        ok: false,
        mensaje: 'Sucursal, caja y sesión son obligatorias',
      });
    }

    const productosVenta = Array.isArray(productos) ? productos : [];

    if (productosVenta.length === 0) {
      return res.status(400).json({
        ok: false,
        mensaje: 'La venta debe contener al menos un producto',
      });
    }

    const metodoPagoFinal = String(metodo_pago || 'EFECTIVO').toUpperCase();

    if (!METODOS_PAGO_PERMITIDOS.includes(metodoPagoFinal)) {
      return res.status(400).json({
        ok: false,
        mensaje: 'Método de pago no válido',
      });
    }

    const esPagoConPuntos = metodoPagoFinal === 'PUNTOS';

    await client.query('BEGIN');

    const accesoCaja = await validarAccesoCajaAsignada({
      db: client,
      usuario: req.usuario,
      idCaja: id_caja,
      idSucursal: id_sucursal,
      bloquear: true,
    });

    if (!accesoCaja.ok) {
      await client.query('ROLLBACK');
      return responderAccesoCajaDenegado(res, accesoCaja);
    }

    const sesion = await client.query(
      `
      SELECT 
        id_sesion,
        id_caja,
        id_sucursal,
        estado
      FROM caja_sesiones
      WHERE id_sesion = $1
        AND id_caja = $2
        AND id_sucursal = $3
      FOR UPDATE
      `,
      [id_sesion, id_caja, id_sucursal]
    );

    if (sesion.rows.length === 0) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        ok: false,
        mensaje: 'No se encontró la sesión de caja indicada',
      });
    }

    if (sesion.rows[0].estado !== 'ABIERTA') {
      await client.query('ROLLBACK');

      return res.status(400).json({
        ok: false,
        mensaje: 'La caja no está abierta',
      });
    }

    let tarjetaPuntos = null;

    if (id_tarjeta_puntos) {
      const tarjetaResultado = await client.query(
        `
        SELECT
          id_tarjeta,
          codigo_barras,
          nombre_cliente,
          correo,
          puntos_actuales,
          puntos_acumulados,
          puntos_canjeados,
          activo
        FROM tarjetas_puntos
        WHERE id_tarjeta = $1
        FOR UPDATE
        `,
        [id_tarjeta_puntos]
      );

      if (tarjetaResultado.rows.length === 0) {
        await client.query('ROLLBACK');

        return res.status(404).json({
          ok: false,
          mensaje: 'Tarjeta de puntos no encontrada',
        });
      }

      tarjetaPuntos = tarjetaResultado.rows[0];

      if (!tarjetaPuntos.activo) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          ok: false,
          mensaje: 'La tarjeta de puntos está inactiva',
        });
      }
    }

    if (esPagoConPuntos && !tarjetaPuntos) {
      await client.query('ROLLBACK');

      return res.status(400).json({
        ok: false,
        mensaje: 'Para pagar con puntos debes vincular una tarjeta de puntos',
      });
    }

    let subtotalVenta = 0;
    let subtotalSinDescuentoVenta = 0;
    let descuentoOfertasVenta = 0;

    let puntosClienteGanados = 0;
    let puntosCajeroGanados = 0;

    const productosProcesados = [];

    for (const item of productosVenta) {
      const { id_producto, cantidad } = item;
      const idVarianteSeleccionada = item.id_variante
        ? Number(item.id_variante)
        : null;
      const idLoteSeleccionado = item.id_lote ? Number(item.id_lote) : null;

      if (!id_producto || !cantidad || Number(cantidad) <= 0) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          ok: false,
          mensaje:
            'Cada producto debe tener id_producto y cantidad mayor a cero',
        });
      }

      const productoResultado = await client.query(
        `
  SELECT
    id_producto,
    id_categoria,
    nombre,
    precio_venta,
    activo,
    usa_variantes,
    controla_lotes,
    controla_caducidad
  FROM productos
  WHERE id_producto = $1
    AND activo = true
  `,
        [id_producto]
      );

      if (productoResultado.rows.length === 0) {
        await client.query('ROLLBACK');

        return res.status(404).json({
          ok: false,
          mensaje: `Producto no encontrado o desactivado: ${id_producto}`,
        });
      }

      const producto = productoResultado.rows[0];
      const usaVariantes = esValorActivo(producto.usa_variantes);

      let varianteSeleccionada = null;
      let stockVarianteAnterior = null;
      let stockVarianteNuevo = null;

      if (usaVariantes) {
        if (
          !Number.isInteger(idVarianteSeleccionada) ||
          idVarianteSeleccionada <= 0
        ) {
          await client.query('ROLLBACK');

          return res.status(400).json({
            ok: false,
            mensaje: `Debes seleccionar una variante para ${producto.nombre}`,
          });
        }

        const varianteResultado = await client.query(
          `
          SELECT
            ivs.id_inventario_variante,
            ivs.stock_actual,
            ivs.activo AS inventario_variante_activo,
            pv.id_variante,
            pv.nombre_variante,
            pv.sku,
            pv.codigo_barras,
            pv.talla,
            pv.color,
            pv.tono,
            pv.presentacion,
            pv.precio_venta AS precio_venta_variante,
            COALESCE(pv.atributos, '{}'::jsonb) AS atributos,
            pv.activo AS variante_activa
          FROM inventario_variantes_sucursal ivs
          INNER JOIN producto_variantes pv
            ON pv.id_variante = ivs.id_variante
          WHERE ivs.id_sucursal = $1
            AND ivs.id_producto = $2
            AND ivs.id_variante = $3
          FOR UPDATE OF ivs
          `,
          [id_sucursal, id_producto, idVarianteSeleccionada]
        );

        if (varianteResultado.rows.length === 0) {
          await client.query('ROLLBACK');

          return res.status(404).json({
            ok: false,
            mensaje: `La variante seleccionada de ${producto.nombre} no existe en esta sucursal`,
          });
        }

        varianteSeleccionada = varianteResultado.rows[0];

        if (
          !esValorActivo(varianteSeleccionada.variante_activa) ||
          !esValorActivo(varianteSeleccionada.inventario_variante_activo)
        ) {
          await client.query('ROLLBACK');

          return res.status(400).json({
            ok: false,
            mensaje: `La variante seleccionada de ${producto.nombre} está inactiva`,
          });
        }

        stockVarianteAnterior = Number(
          varianteSeleccionada.stock_actual || 0
        );

        if (stockVarianteAnterior < Number(cantidad)) {
          await client.query('ROLLBACK');

          return res.status(400).json({
            ok: false,
            mensaje: `Stock insuficiente para la variante ${varianteSeleccionada.nombre_variante || idVarianteSeleccionada} de ${producto.nombre}`,
            stock_variante: stockVarianteAnterior,
            cantidad_solicitada: Number(cantidad),
          });
        }
      } else if (idVarianteSeleccionada) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          ok: false,
          mensaje: `El producto ${producto.nombre} no está configurado para usar variantes`,
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
          mensaje: `El producto ${producto.nombre} no tiene inventario en esta sucursal`,
        });
      }

      const stockActual = Number(inventarioResultado.rows[0].stock_actual);
      const cantidadVenta = Number(cantidad);

      if (stockActual < cantidadVenta) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          ok: false,
          mensaje: `Stock insuficiente para ${producto.nombre}`,
          stock_actual: stockActual,
          cantidad_solicitada: cantidadVenta,
        });
      }

      const precioBaseDB = redondearDos(
        varianteSeleccionada?.precio_venta_variante !== undefined &&
        varianteSeleccionada?.precio_venta_variante !== null &&
        varianteSeleccionada?.precio_venta_variante !== ''
          ? varianteSeleccionada.precio_venta_variante
          : producto.precio_venta
      );

      const idOferta = item.id_oferta ? Number(item.id_oferta) : null;
      const porcentajeDescuento = redondearDos(item.porcentaje_descuento || 0);
      const descuentoUnitario = redondearDos(item.descuento_unitario || 0);

      const precioOriginal =
        item.precio_original !== undefined &&
          item.precio_original !== null &&
          item.precio_original !== ''
          ? redondearDos(item.precio_original)
          : precioBaseDB;

      let precioUnitario =
        item.precio_unitario !== undefined &&
          item.precio_unitario !== null &&
          item.precio_unitario !== ''
          ? redondearDos(item.precio_unitario)
          : precioBaseDB;

      let ofertaValidada = null;

      if (idOferta || porcentajeDescuento > 0 || descuentoUnitario > 0) {
        if (!idOferta) {
          await client.query('ROLLBACK');

          return res.status(400).json({
            ok: false,
            mensaje: `El producto ${producto.nombre} tiene descuento de oferta, pero no trae id_oferta`,
          });
        }

        ofertaValidada = await validarOfertaProducto({
          client,
          idOferta,
          idProducto: id_producto,
          idCategoriaProducto: producto.id_categoria,
        });

        const porcentajeDB = redondearDos(ofertaValidada.porcentaje_descuento);
        const descuentoUnitarioCalculado = redondearDos(
          precioBaseDB * (porcentajeDB / 100)
        );
        const precioConDescuentoCalculado = redondearDos(
          precioBaseDB - descuentoUnitarioCalculado
        );

        const diferenciaPrecio = Math.abs(
          precioUnitario - precioConDescuentoCalculado
        );

        if (diferenciaPrecio > 0.02) {
          await client.query('ROLLBACK');

          return res.status(400).json({
            ok: false,
            mensaje: `El precio con oferta del producto ${producto.nombre} no coincide con la configuración vigente`,
            precio_enviado: precioUnitario,
            precio_esperado: precioConDescuentoCalculado,
          });
        }

        precioUnitario = precioConDescuentoCalculado;
      }

      const descuentoProductoManual = redondearDos(item.descuento || 0);
      const subtotalProducto = redondearDos(
        cantidadVenta * precioUnitario - descuentoProductoManual
      );

      const subtotalOriginalProducto = redondearDos(
        cantidadVenta * precioOriginal
      );

      const descuentoOfertaProducto = redondearDos(
        cantidadVenta * descuentoUnitario
      );

      if (subtotalProducto < 0) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          ok: false,
          mensaje: `El subtotal del producto ${producto.nombre} no puede ser negativo`,
        });
      }

      const controlaLotes = esValorActivo(producto.controla_lotes);

      // Un producto que no controla lotes no debe intentar descontar de
      // inventario_lotes. Para productos con control de lotes se respeta el
      // lote elegido; si no se eligió uno explícitamente, se usa FEFO.
      let resultadoLotes = {
        ok: true,
        lotes_descontados: [],
      };

      if (controlaLotes) {
        resultadoLotes = idLoteSeleccionado
          ? await descontarLoteSeleccionado({
            client,
            id_sucursal,
            id_producto,
            id_variante: idVarianteSeleccionada,
            usaVariantes,
            id_lote: idLoteSeleccionado,
            cantidadVenta,
          })
          : await descontarLotesFEFO({
            client,
            id_sucursal,
            id_producto,
            id_variante: idVarianteSeleccionada,
            usaVariantes,
            cantidadVenta,
          });
      }

      if (!resultadoLotes.ok) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          ok: false,
          mensaje: `${resultadoLotes.mensaje} para ${producto.nombre}`,
          stock_lotes: resultadoLotes.stock_lotes,
          stock_lote: resultadoLotes.stock_lote,
          cantidad_solicitada: resultadoLotes.cantidad_solicitada,
        });
      }

      if (usaVariantes) {
        stockVarianteNuevo = redondearDos(
          stockVarianteAnterior - cantidadVenta
        );

        await client.query(
          `
          UPDATE inventario_variantes_sucursal
          SET
            stock_actual = $1,
            activo = CASE WHEN $1::numeric > 0 THEN true ELSE activo END,
            fecha_actualizacion = CURRENT_TIMESTAMP
          WHERE id_sucursal = $2
            AND id_producto = $3
            AND id_variante = $4
          `,
          [
            stockVarianteNuevo,
            id_sucursal,
            id_producto,
            idVarianteSeleccionada,
          ]
        );
      }

      const stockNuevo = stockActual - cantidadVenta;

      await client.query(
        `
        UPDATE inventario_sucursal
        SET 
          stock_actual = $1,
          fecha_actualizacion = CURRENT_TIMESTAMP
        WHERE id_sucursal = $2
          AND id_producto = $3
        `,
        [stockNuevo, id_sucursal, id_producto]
      );

      subtotalVenta += subtotalProducto;
      subtotalSinDescuentoVenta += subtotalOriginalProducto;
      descuentoOfertasVenta += descuentoOfertaProducto;

      const lotePrincipal = resultadoLotes.lotes_descontados?.[0] || null;

      productosProcesados.push({
        id_producto,
        id_variante: idVarianteSeleccionada,
        nombre_variante: varianteSeleccionada?.nombre_variante || null,
        sku_variante: varianteSeleccionada?.sku || null,
        codigo_barras_variante: varianteSeleccionada?.codigo_barras || null,
        atributos_variante: varianteSeleccionada?.atributos || {},
        id_lote: lotePrincipal?.id_lote || null,
        lote: lotePrincipal?.lote || null,
        fecha_caducidad: lotePrincipal?.fecha_caducidad || null,

        nombre: producto.nombre,
        cantidad: cantidadVenta,

        precio_original: precioOriginal,
        precio_unitario: precioUnitario,

        porcentaje_descuento: ofertaValidada
          ? redondearDos(ofertaValidada.porcentaje_descuento)
          : 0,
        descuento_unitario: ofertaValidada ? descuentoUnitario : 0,
        id_oferta: ofertaValidada ? ofertaValidada.id_oferta : null,
        oferta_nombre: ofertaValidada ? ofertaValidada.nombre : null,

        descuento: descuentoProductoManual,
        subtotal: subtotalProducto,
        subtotal_original: subtotalOriginalProducto,
        descuento_oferta: descuentoOfertaProducto,

        stock_anterior: stockActual,
        stock_nuevo: stockNuevo,
        lotes_descontados: resultadoLotes.lotes_descontados,
      });
    }

    subtotalVenta = redondearDos(subtotalVenta);
    subtotalSinDescuentoVenta = redondearDos(subtotalSinDescuentoVenta);
    descuentoOfertasVenta = redondearDos(descuentoOfertasVenta);

    const descuentoVenta = redondearDos(descuento || 0);
    const impuestoVenta = redondearDos(impuesto || 0);
    const totalVenta = redondearDos(
      subtotalVenta - descuentoVenta + impuestoVenta
    );

    if (totalVenta < 0) {
      await client.query('ROLLBACK');

      return res.status(400).json({
        ok: false,
        mensaje: 'El total de la venta no puede ser negativo',
      });
    }

    const esPagoMixto = metodoPagoFinal === 'MIXTO';

    let pagosVenta = [];
    let puntosUsados = 0;
    let montoPagadoPuntos = 0;
    let montoPagadoDinero = 0;
    let montoRecibidoFinal = 0;
    let cambio = 0;

    if (esPagoMixto) {
      const pagosNormalizados = normalizarPagosMixtos(pagos);

      if (!pagosNormalizados.ok) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          ok: false,
          mensaje: pagosNormalizados.mensaje,
        });
      }

      if (pagosNormalizados.pagos.length === 0) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          ok: false,
          mensaje: 'Debes capturar al menos un pago para una venta mixta',
        });
      }

      const efectivoRecibido = redondearDos(pagosNormalizados.acumulado.EFECTIVO || 0);
      const tarjetaPagada = redondearDos(pagosNormalizados.acumulado.TARJETA || 0);
      const transferenciaPagada = redondearDos(pagosNormalizados.acumulado.TRANSFERENCIA || 0);
      const puntosPagados = redondearDos(pagosNormalizados.acumulado.PUNTOS || 0);

      const pagosNoEfectivo = redondearDos(
        tarjetaPagada + transferenciaPagada + puntosPagados
      );

      if (pagosNoEfectivo - totalVenta > 0.02) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          ok: false,
          mensaje:
            'Los pagos con tarjeta, transferencia o puntos no pueden exceder el total de la venta',
          total: totalVenta,
          pagos_no_efectivo: pagosNoEfectivo,
        });
      }

      const pendienteAntesDeEfectivo = redondearDos(
        Math.max(totalVenta - pagosNoEfectivo, 0)
      );

      const efectivoAplicado = redondearDos(
        Math.min(efectivoRecibido, pendienteAntesDeEfectivo)
      );

      cambio = redondearDos(
        Math.max(efectivoRecibido - pendienteAntesDeEfectivo, 0)
      );

      montoPagadoPuntos = puntosPagados;
      puntosUsados = puntosPagados;
      montoPagadoDinero = redondearDos(
        efectivoAplicado + tarjetaPagada + transferenciaPagada
      );

      const totalCubierto = redondearDos(montoPagadoDinero + montoPagadoPuntos);

      if (totalCubierto + 0.02 < totalVenta) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          ok: false,
          mensaje: 'El total pagado no cubre el total de la venta',
          total: totalVenta,
          total_pagado: totalCubierto,
          pendiente: redondearDos(totalVenta - totalCubierto),
        });
      }

      montoRecibidoFinal = redondearDos(
        efectivoRecibido + tarjetaPagada + transferenciaPagada + puntosPagados
      );

      pagosVenta = [
        efectivoAplicado > 0
          ? {
            metodo_pago: 'EFECTIVO',
            monto: efectivoAplicado,
            referencia: null,
            monto_recibido: efectivoRecibido,
            cambio,
          }
          : null,
        tarjetaPagada > 0
          ? {
            metodo_pago: 'TARJETA',
            monto: tarjetaPagada,
            referencia: null,
          }
          : null,
        transferenciaPagada > 0
          ? {
            metodo_pago: 'TRANSFERENCIA',
            monto: transferenciaPagada,
            referencia: null,
          }
          : null,
        puntosPagados > 0
          ? {
            metodo_pago: 'PUNTOS',
            monto: puntosPagados,
            referencia: tarjetaPuntos?.codigo_barras || null,
          }
          : null,
      ].filter(Boolean);
    } else {
      if (esPagoConPuntos) {
        puntosUsados = totalVenta;
        montoPagadoPuntos = totalVenta;
        montoPagadoDinero = 0;
        montoRecibidoFinal = 0;
        cambio = 0;
      } else {
        puntosUsados = 0;
        montoPagadoPuntos = 0;
        montoPagadoDinero = totalVenta;
        montoRecibidoFinal = redondearDos(monto_recibido || 0);

        if (metodoPagoFinal === 'EFECTIVO' && montoRecibidoFinal < totalVenta) {
          await client.query('ROLLBACK');

          return res.status(400).json({
            ok: false,
            mensaje: 'El monto recibido no cubre el total de la venta',
            total: totalVenta,
            monto_recibido: montoRecibidoFinal,
          });
        }

        cambio =
          metodoPagoFinal === 'EFECTIVO'
            ? redondearDos(montoRecibidoFinal - totalVenta)
            : 0;
      }

      pagosVenta = [
        {
          metodo_pago: metodoPagoFinal,
          monto: totalVenta,
          referencia:
            metodoPagoFinal === 'PUNTOS'
              ? tarjetaPuntos?.codigo_barras || null
              : null,
          monto_recibido:
            metodoPagoFinal === 'EFECTIVO' ? montoRecibidoFinal : totalVenta,
          cambio,
        },
      ];
    }

    if (puntosUsados > 0 && !tarjetaPuntos) {
      await client.query('ROLLBACK');

      return res.status(400).json({
        ok: false,
        mensaje: 'Para pagar con puntos debes vincular una tarjeta de puntos',
      });
    }

    if (
      puntosUsados > 0 &&
      Number(tarjetaPuntos.puntos_actuales || 0) < puntosUsados
    ) {
      await client.query('ROLLBACK');

      return res.status(400).json({
        ok: false,
        mensaje: 'La tarjeta no tiene puntos suficientes para pagar la venta',
        puntos_actuales: Number(tarjetaPuntos.puntos_actuales || 0),
        puntos_requeridos: puntosUsados,
      });
    }

    const configuracionPuntos = await obtenerConfiguracionPuntos(client);

    puntosClienteGanados =
      tarjetaPuntos && montoPagadoDinero > 0
        ? calcularPuntosPorcentaje({
          total: montoPagadoDinero,
          porcentaje: configuracionPuntos.porcentaje_cliente,
          activo: configuracionPuntos.puntos_cliente_activo,
        })
        : 0;

    puntosCajeroGanados = calcularPuntosPorcentaje({
      total: totalVenta,
      porcentaje: configuracionPuntos.porcentaje_cajero,
      activo: configuracionPuntos.puntos_cajero_activo,
    });

    const folio = generarFolioVenta();

    const ventaResultado = await client.query(
      `
  INSERT INTO ventas (
    folio,
    id_sucursal,
    id_caja,
    id_sesion,
    id_usuario,
    subtotal,
    subtotal_sin_descuento,
    descuento_ofertas,
    descuento,
    impuesto,
    total,
    metodo_pago,
    monto_recibido,
    cambio,
    estado,
    id_tarjeta_puntos,
    puntos_ganados,
    monto_pagado_dinero,
    monto_pagado_puntos,
    puntos_usados
  )
  VALUES (
    $1,$2,$3,$4,$5,
    $6,$7,$8,$9,$10,
    $11,$12,$13,$14,'COMPLETADA',
    $15,$16,$17,$18,$19
  )
  RETURNING *
  `,
      [
        folio,
        id_sucursal,
        id_caja,
        id_sesion,
        req.usuario.id_usuario,
        subtotalVenta,
        subtotalSinDescuentoVenta,
        descuentoOfertasVenta,
        descuentoVenta,
        impuestoVenta,
        totalVenta,
        metodoPagoFinal,
        montoRecibidoFinal,
        cambio,
        tarjetaPuntos?.id_tarjeta || null,
        puntosClienteGanados,
        montoPagadoDinero,
        montoPagadoPuntos,
        puntosUsados,
      ]
    );

    const venta = ventaResultado.rows[0];

    for (const pago of pagosVenta) {
      await client.query(
        `
        INSERT INTO ventas_pagos (
          id_venta,
          metodo_pago,
          monto,
          referencia
        )
        VALUES ($1,$2,$3,$4)
        `,
        [
          venta.id_venta,
          pago.metodo_pago,
          redondearDos(pago.monto),
          pago.referencia || null,
        ]
      );
    }

    for (const item of productosProcesados) {
      const detalleVentaResultado = await client.query(
        `
        INSERT INTO venta_detalle (
          id_venta,
          id_producto,
          id_variante,
          id_lote,
          cantidad,
          precio_unitario,
          precio_original,
          porcentaje_descuento,
          descuento_unitario,
          id_oferta,
          descuento,
          subtotal
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
        )
        RETURNING id_detalle
        `,
        [
          venta.id_venta,
          item.id_producto,
          item.id_variante,
          item.id_lote,
          item.cantidad,
          item.precio_unitario,
          item.precio_original,
          item.porcentaje_descuento,
          item.descuento_unitario,
          item.id_oferta,
          item.descuento,
          item.subtotal,
        ]
      );

      for (const loteDesc of item.lotes_descontados) {
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
          VALUES ($1,$2,$3,$4,'VENTA',$5,$6,$7,$8,$9,$10)
          `,
          [
            id_sucursal,
            item.id_producto,
            item.id_variante,
            loteDesc.id_lote,
            loteDesc.cantidad_descontada,
            item.stock_anterior,
            item.stock_nuevo,
            folio,
            `Venta ${folio} | Lote ${loteDesc.lote}`,
            req.usuario.id_usuario,
          ]
        );
      }
    }

    let tarjetaActualizada = null;

    if (puntosUsados > 0) {
      const puntosAnteriores = Number(tarjetaPuntos.puntos_actuales || 0);
      const puntosNuevos = redondearDos(puntosAnteriores - puntosUsados);

      const tarjetaUpdate = await client.query(
        `
        UPDATE tarjetas_puntos
        SET
          puntos_actuales = puntos_actuales - $1,
          puntos_canjeados = puntos_canjeados + $1,
          fecha_actualizacion = CURRENT_TIMESTAMP
        WHERE id_tarjeta = $2
        RETURNING
          id_tarjeta,
          codigo_barras,
          nombre_cliente,
          puntos_actuales,
          puntos_acumulados,
          puntos_canjeados,
          activo
        `,
        [puntosUsados, tarjetaPuntos.id_tarjeta]
      );

      tarjetaActualizada = tarjetaUpdate.rows[0];

      await client.query(
        `
        INSERT INTO tarjetas_puntos_movimientos (
          id_tarjeta,
          id_venta,
          id_usuario,
          tipo_movimiento,
          puntos,
          puntos_anteriores,
          puntos_nuevos,
          descripcion
        )
        VALUES ($1,$2,$3,'CANJE',$4,$5,$6,$7)
        `,
        [
          tarjetaPuntos.id_tarjeta,
          venta.id_venta,
          req.usuario.id_usuario,
          puntosUsados * -1,
          puntosAnteriores,
          puntosNuevos,
          `Pago con puntos en venta ${folio}`,
        ]
      );
    }

    if (tarjetaPuntos && puntosClienteGanados > 0) {
      const puntosAnteriores = Number(tarjetaPuntos.puntos_actuales || 0);
      const puntosNuevos = redondearDos(puntosAnteriores + puntosClienteGanados);

      const tarjetaUpdate = await client.query(
        `
        UPDATE tarjetas_puntos
        SET
          puntos_actuales = puntos_actuales + $1,
          puntos_acumulados = puntos_acumulados + $1,
          fecha_actualizacion = CURRENT_TIMESTAMP
        WHERE id_tarjeta = $2
        RETURNING
          id_tarjeta,
          codigo_barras,
          nombre_cliente,
          puntos_actuales,
          puntos_acumulados,
          puntos_canjeados,
          activo
        `,
        [puntosClienteGanados, tarjetaPuntos.id_tarjeta]
      );

      tarjetaActualizada = tarjetaUpdate.rows[0];

      await client.query(
        `
        INSERT INTO tarjetas_puntos_movimientos (
          id_tarjeta,
          id_venta,
          id_usuario,
          tipo_movimiento,
          puntos,
          puntos_anteriores,
          puntos_nuevos,
          descripcion
        )
        VALUES ($1,$2,$3,'ACUMULACION',$4,$5,$6,$7)
        `,
        [
          tarjetaPuntos.id_tarjeta,
          venta.id_venta,
          req.usuario.id_usuario,
          puntosClienteGanados,
          puntosAnteriores,
          puntosNuevos,
          `Puntos acumulados por venta ${folio}`,
        ]
      );
    }

    if (puntosCajeroGanados > 0) {
      await client.query(
        `
        INSERT INTO cajeros_puntos_movimientos (
          id_usuario,
          id_venta,
          tipo_movimiento,
          puntos,
          porcentaje_aplicado,
          monto_base,
          descripcion
        )
        VALUES ($1,$2,'VENTA',$3,$4,$5,$6)
        `,
        [
          req.usuario.id_usuario,
          venta.id_venta,
          puntosCajeroGanados,
          Number(configuracionPuntos.porcentaje_cajero || 0),
          totalVenta,
          `Puntos generados al cajero por venta ${folio}`,
        ]
      );
    }

    const pagosConMovimientoCaja = pagosVenta.filter((pago) => {
      return Number(pago.monto || 0) > 0;
    });

    for (const pagoCaja of pagosConMovimientoCaja) {
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
    VALUES ($1,$2,'VENTA',$3,$4,$5,$6,$7,$8)
    `,
        [
          id_sesion,
          id_sucursal,
          `Venta ${folio}`,
          redondearDos(pagoCaja.monto),
          pagoCaja.metodo_pago,
          folio,
          tarjetaPuntos
            ? `Venta registrada desde POS | Método ${pagoCaja.metodo_pago} | Tarjeta ${tarjetaPuntos.codigo_barras} | Puntos usados: ${puntosUsados} | Puntos cliente: ${puntosClienteGanados} | Descuento ofertas: ${descuentoOfertasVenta} | Puntos cajero: ${puntosCajeroGanados}`
            : `Venta registrada desde POS | Método ${pagoCaja.metodo_pago} | Descuento ofertas: ${descuentoOfertasVenta} | Puntos cajero: ${puntosCajeroGanados}`,
          req.usuario.id_usuario,
        ]
      );
    }

    await client.query('COMMIT');

    /*
     * El envío del ticket digital ocurre después del COMMIT.
     * Si el correo falla, la venta ya quedó registrada y el error solo se
     * devuelve como información al POS; nunca se revierte una venta válida.
     */
    const tarjetaParaTicketDigital = tarjetaPuntos
      ? {
        ...tarjetaPuntos,
        ...(tarjetaActualizada || {}),
      }
      : null;

    const ticketDigital = esValorActivo(enviar_ticket_digital)
      ? await enviarTicketDigitalVenta({
        idSucursal: Number(id_sucursal),
        tarjeta: tarjetaParaTicketDigital,
        venta,
        productos: productosProcesados,
        pagos: pagosVenta,
        resumen: {
          subtotal: subtotalVenta,
          subtotal_sin_descuento: subtotalSinDescuentoVenta,
          descuento_ofertas: descuentoOfertasVenta,
          descuento: descuentoVenta,
          impuesto: impuestoVenta,
          total: totalVenta,
          metodo_pago: metodoPagoFinal,
          monto_recibido: montoRecibidoFinal,
          cambio,
          monto_pagado_dinero: montoPagadoDinero,
          monto_pagado_puntos: montoPagadoPuntos,
          puntos_usados: puntosUsados,
          puntos_ganados: puntosClienteGanados,
          puntos_ganados_cliente: puntosClienteGanados,
        },
      })
      : {
        solicitado: false,
        enviado: false,
        estatus: 'NO_SOLICITADO',
        mensaje: 'No se solicitó el envío de ticket digital para esta venta.',
      };

    return res.status(201).json({
      ok: true,
      mensaje: 'Venta registrada correctamente',
      venta: {
        ...venta,
        productos: productosProcesados,
        pagos: pagosVenta,
        tarjeta_puntos: tarjetaActualizada,
        ticket_digital: ticketDigital,
      },
      resumen: {
        subtotal: subtotalVenta,
        subtotal_sin_descuento: subtotalSinDescuentoVenta,
        descuento_ofertas: descuentoOfertasVenta,
        descuento: descuentoVenta,
        impuesto: impuestoVenta,
        total: totalVenta,
        metodo_pago: metodoPagoFinal,
        monto_recibido: montoRecibidoFinal,
        cambio,
        monto_pagado_dinero: montoPagadoDinero,
        monto_pagado_puntos: montoPagadoPuntos,
        puntos_usados: puntosUsados,
        pagos: pagosVenta,
        puntos_ganados: puntosClienteGanados,
        puntos_ganados_cliente: puntosClienteGanados,
        puntos_ganados_cajero: puntosCajeroGanados,
        tarjeta_puntos: tarjetaActualizada,
        ticket_digital: ticketDigital,
        configuracion_puntos: {
          porcentaje_cliente: configuracionPuntos.porcentaje_cliente,
          porcentaje_cajero: configuracionPuntos.porcentaje_cajero,
          puntos_cliente_activo: configuracionPuntos.puntos_cliente_activo,
          puntos_cajero_activo: configuracionPuntos.puntos_cajero_activo,
        },
      },
    });
  } catch (error) {
    await client.query('ROLLBACK');

    console.error('Error al crear venta:', error);

    return res.status(500).json({
      ok: false,
      mensaje: error.message || 'Error interno al registrar venta',
    });
  } finally {
    client.release();
  }
};

export const obtenerInfoDevolucionVenta = async (req, res) => {
  try {
    const { id } = req.params;

    const ventaResultado = await pool.query(
      `
      SELECT
        v.id_venta,
        v.folio,
        v.id_sucursal,
        s.nombre AS sucursal,
        v.id_caja,
        c.nombre AS caja,
        v.id_sesion,
        v.id_usuario,
        u.nombre AS usuario,
        v.subtotal,
        v.descuento,
        v.impuesto,
        v.total,
        v.metodo_pago,
        v.monto_recibido,
        v.cambio,
        v.estado,
        v.fecha_venta
      FROM ventas v
      INNER JOIN sucursales s ON s.id_sucursal = v.id_sucursal
      INNER JOIN cajas c ON c.id_caja = v.id_caja
      INNER JOIN usuarios u ON u.id_usuario = v.id_usuario
      WHERE v.id_venta = $1
      `,
      [id]
    );

    if (ventaResultado.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        mensaje: 'Venta no encontrada',
      });
    }

    const venta = ventaResultado.rows[0];

    const accesoCaja = await validarAccesoCajaAsignada({
      db: pool,
      usuario: req.usuario,
      idCaja: venta.id_caja,
      idSucursal: venta.id_sucursal,
    });

    if (!accesoCaja.ok) {
      return responderAccesoCajaDenegado(res, accesoCaja);
    }

    /*
     * Compatibilidad con ventas históricas:
     * algunas ventas/lotes antiguos recibieron id_variante durante la migración
     * aunque el producto actualmente NO usa variantes. Para la devolución
     * exponemos la variante únicamente cuando productos.usa_variantes = true.
     */
    const detalleResultado = await pool.query(
      `
      SELECT
        vd.id_detalle,
        vd.id_venta,
        vd.id_producto,

        CASE
          WHEN COALESCE(p.usa_variantes, false) = true
            THEN vd.id_variante
          ELSE NULL
        END AS id_variante,

        p.usa_variantes,
        p.controla_lotes,
        p.nombre AS producto,
        p.codigo_barras,

        CASE
          WHEN COALESCE(p.usa_variantes, false) = true
            THEN pv.nombre_variante
          ELSE NULL
        END AS nombre_variante,

        CASE
          WHEN COALESCE(p.usa_variantes, false) = true
            THEN pv.sku
          ELSE NULL
        END AS sku_variante,

        CASE
          WHEN COALESCE(p.usa_variantes, false) = true
            THEN pv.codigo_barras
          ELSE NULL
        END AS codigo_barras_variante,

        CASE
          WHEN COALESCE(p.usa_variantes, false) = true
            THEN pv.talla
          ELSE NULL
        END AS talla,

        CASE
          WHEN COALESCE(p.usa_variantes, false) = true
            THEN pv.color
          ELSE NULL
        END AS color,

        CASE
          WHEN COALESCE(p.usa_variantes, false) = true
            THEN pv.tono
          ELSE NULL
        END AS tono,

        CASE
          WHEN COALESCE(p.usa_variantes, false) = true
            THEN pv.presentacion
          ELSE NULL
        END AS presentacion_variante,

        CASE
          WHEN COALESCE(p.usa_variantes, false) = true
            THEN COALESCE(pv.atributos, '{}'::jsonb)
          ELSE '{}'::jsonb
        END AS atributos_variante,

        vd.id_lote,
        il.lote,
        il.fecha_caducidad,
        vd.cantidad,
        vd.precio_unitario,
        vd.descuento,
        vd.subtotal,

        COALESCE(
          dev.cantidad_devuelta,
          0
        )::numeric(12,2) AS cantidad_devuelta,

        (
          COALESCE(vd.cantidad, 0) -
          COALESCE(dev.cantidad_devuelta, 0)
        )::numeric(12,2) AS cantidad_disponible_devolver

      FROM venta_detalle vd
      INNER JOIN productos p
        ON p.id_producto = vd.id_producto

      LEFT JOIN producto_variantes pv
        ON pv.id_variante = vd.id_variante
       AND COALESCE(p.usa_variantes, false) = true

      LEFT JOIN inventario_lotes il
        ON il.id_lote = vd.id_lote

      LEFT JOIN (
        SELECT
          id_detalle,
          COALESCE(
            SUM(cantidad_devuelta),
            0
          )::numeric(12,2) AS cantidad_devuelta
        FROM ventas_devoluciones_detalle
        GROUP BY id_detalle
      ) dev
        ON dev.id_detalle = vd.id_detalle

      WHERE vd.id_venta = $1
      ORDER BY vd.id_detalle ASC
      `,
      [id]
    );

    const montoDevueltoResultado = await pool.query(
      `
      SELECT
        COALESCE(
          SUM(monto_devuelto),
          0
        )::numeric(12,2) AS monto_devuelto
      FROM ventas_devoluciones
      WHERE id_venta = $1
        AND estado = 'APLICADA'
      `,
      [id]
    );

    return res.json({
      ok: true,
      venta: {
        ...venta,
        monto_devuelto: Number(
          montoDevueltoResultado.rows[0]?.monto_devuelto || 0
        ),
      },
      productos: detalleResultado.rows,
    });
  } catch (error) {
    console.error(
      'Error al obtener información de devolución:',
      error
    );

    return res.status(500).json({
      ok: false,
      mensaje:
        'Error interno al obtener información de devolución',
    });
  }
};

export const listarVentas = async (req, res) => {
  try {
    const {
      sucursal,
      sesion,
      fecha_inicio,
      fecha_fin,
    } = req.query;

    let query = `
      SELECT
        v.id_venta,
        v.folio,
        v.id_sucursal,
        s.nombre AS sucursal,
        v.id_caja,
        c.nombre AS caja,
        v.id_sesion,
        v.id_usuario,
        u.nombre AS usuario,
        v.subtotal,
        v.subtotal_sin_descuento,
        v.descuento_ofertas,
        v.descuento,
        v.impuesto,
        v.total,
        v.monto_pagado_dinero,
        v.monto_pagado_puntos,
        v.puntos_usados,
        v.metodo_pago,
        v.monto_recibido,
        v.cambio,
        v.estado,
        v.id_tarjeta_puntos,
        tp.codigo_barras AS tarjeta_codigo_barras,
        tp.nombre_cliente AS tarjeta_cliente,
        v.puntos_ganados,
        v.fecha_venta,
        COALESCE(cpm.puntos, 0)::numeric(12,2) AS puntos_cajero
      FROM ventas v
      INNER JOIN sucursales s
        ON s.id_sucursal = v.id_sucursal
      INNER JOIN cajas c
        ON c.id_caja = v.id_caja
      INNER JOIN usuarios u
        ON u.id_usuario = v.id_usuario
      LEFT JOIN tarjetas_puntos tp
        ON tp.id_tarjeta = v.id_tarjeta_puntos
      LEFT JOIN cajeros_puntos_movimientos cpm
        ON cpm.id_venta = v.id_venta
        AND cpm.id_usuario = v.id_usuario
        AND cpm.tipo_movimiento = 'VENTA'
      WHERE 1 = 1
    `;

    const params = [];

    /*
     * Los usuarios normales solamente pueden consultar las ventas
     * correspondientes a la caja que tienen asignada.
     */
    if (!esSuperAdmin(req.usuario)) {
      const idUsuario =
        obtenerIdUsuarioAutenticado(req.usuario);

      if (!idUsuario) {
        return res.status(401).json({
          ok: false,
          mensaje:
            'No se pudo identificar al usuario de la sesión',
        });
      }

      params.push(idUsuario);

      query += `
        AND c.id_usuario_asignado = $${params.length}
      `;
    }

    if (sucursal) {
      params.push(Number(sucursal));

      query += `
        AND v.id_sucursal = $${params.length}
      `;
    }

    if (sesion) {
      params.push(Number(sesion));

      query += `
        AND v.id_sesion = $${params.length}
      `;
    }

    if (fecha_inicio) {
      params.push(fecha_inicio);

      query += `
        AND (
          v.fecha_venta AT TIME ZONE 'America/Mexico_City'
        )::date >= $${params.length}::date
      `;
    }

    if (fecha_fin) {
      params.push(fecha_fin);

      query += `
        AND (
          v.fecha_venta AT TIME ZONE 'America/Mexico_City'
        )::date <= $${params.length}::date
      `;
    }

    query += `
      ORDER BY v.fecha_venta DESC
    `;

    const resultado = await pool.query(query, params);

    return res.json({
      ok: true,
      ventas: resultado.rows,
    });
  } catch (error) {
    console.error('Error al listar ventas:', {
      message: error.message,
      code: error.code,
      detail: error.detail,
      stack: error.stack,
    });

    return res.status(500).json({
      ok: false,
      mensaje: 'Error interno al listar ventas',
    });
  }
};

export const obtenerVenta = async (req, res) => {
  try {
    const { id } = req.params;

    const ventaResultado = await pool.query(
      `
      SELECT
        v.id_venta,
        v.folio,
        v.id_sucursal,
        s.nombre AS sucursal,
        v.id_caja,
        c.nombre AS caja,
        v.id_sesion,
        v.id_usuario,
        u.nombre AS usuario,
        v.subtotal,
        v.subtotal_sin_descuento,
        v.descuento_ofertas,
        v.descuento,
        v.impuesto,
        v.total,
        v.monto_pagado_dinero,
        v.monto_pagado_puntos,
        v.puntos_usados,
        v.metodo_pago,
        v.monto_recibido,
        v.cambio,
        v.estado,
        v.id_tarjeta_puntos,
        tp.codigo_barras AS tarjeta_codigo_barras,
        tp.nombre_cliente AS tarjeta_cliente,
        v.puntos_ganados,
        v.fecha_venta,
        COALESCE(cpm.puntos, 0)::numeric(12,2) AS puntos_cajero,
        cpm.porcentaje_aplicado AS porcentaje_cajero_aplicado
      FROM ventas v
      INNER JOIN sucursales s ON s.id_sucursal = v.id_sucursal
      INNER JOIN cajas c ON c.id_caja = v.id_caja
      INNER JOIN usuarios u ON u.id_usuario = v.id_usuario
      LEFT JOIN tarjetas_puntos tp ON tp.id_tarjeta = v.id_tarjeta_puntos
      LEFT JOIN cajeros_puntos_movimientos cpm
        ON cpm.id_venta = v.id_venta
        AND cpm.id_usuario = v.id_usuario
        AND cpm.tipo_movimiento = 'VENTA'
      WHERE v.id_venta = $1
      `,
      [id]
    );

    if (ventaResultado.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        mensaje: 'Venta no encontrada',
      });
    }

    const venta = ventaResultado.rows[0];

    const accesoCaja = await validarAccesoCajaAsignada({
      db: pool,
      usuario: req.usuario,
      idCaja: venta.id_caja,
      idSucursal: venta.id_sucursal,
    });

    if (!accesoCaja.ok) {
      return responderAccesoCajaDenegado(res, accesoCaja);
    }

    const detalleResultado = await pool.query(
      `
      SELECT
        vd.id_detalle,
        vd.id_producto,
        vd.id_variante,
        pv.nombre_variante,
        pv.sku AS sku_variante,
        pv.codigo_barras AS codigo_barras_variante,
        pv.talla,
        pv.color,
        pv.tono,
        pv.presentacion AS presentacion_variante,
        COALESCE(pv.atributos, '{}'::jsonb) AS atributos_variante,
        vd.id_lote,
        il.lote,
        il.fecha_caducidad,
        p.codigo_barras,
        p.nombre AS producto,
        vd.cantidad,
        vd.precio_unitario,
        vd.precio_original,
        vd.porcentaje_descuento,
        vd.descuento_unitario,
        vd.id_oferta,
        oc.nombre AS oferta_nombre,
        vd.descuento,
        vd.subtotal
      FROM venta_detalle vd
      INNER JOIN productos p ON p.id_producto = vd.id_producto
      LEFT JOIN producto_variantes pv ON pv.id_variante = vd.id_variante
      LEFT JOIN inventario_lotes il ON il.id_lote = vd.id_lote
      LEFT JOIN ofertas_categorias oc ON oc.id_oferta = vd.id_oferta
      WHERE vd.id_venta = $1
      ORDER BY vd.id_detalle ASC
      `,
      [id]
    );

    const pagosResultado = await pool.query(
      `
      SELECT
        id_pago,
        id_venta,
        metodo_pago,
        monto,
        referencia,
        fecha_pago
      FROM ventas_pagos
      WHERE id_venta = $1
      ORDER BY id_pago ASC
      `,
      [id]
    );

    const lotesResultado = await pool.query(
      `
      SELECT
        im.id_movimiento,
        im.id_producto,
        p.nombre AS producto,
        im.id_variante,
        pv.nombre_variante,
        pv.sku AS sku_variante,
        pv.codigo_barras AS codigo_barras_variante,
        pv.talla,
        pv.color,
        pv.tono,
        pv.presentacion AS presentacion_variante,
        COALESCE(pv.atributos, '{}'::jsonb) AS atributos_variante,
        im.id_lote,
        il.lote,
        il.fecha_caducidad,
        im.cantidad,
        im.stock_anterior,
        im.stock_nuevo,
        im.referencia,
        im.observaciones,
        im.fecha_movimiento
      FROM inventario_movimientos im
      INNER JOIN productos p ON p.id_producto = im.id_producto
      LEFT JOIN producto_variantes pv ON pv.id_variante = im.id_variante
      LEFT JOIN inventario_lotes il ON il.id_lote = im.id_lote
      WHERE im.referencia = $1
        AND im.tipo_movimiento = 'VENTA'
      ORDER BY p.nombre ASC, il.fecha_caducidad ASC NULLS LAST
      `,
      [ventaResultado.rows[0].folio]
    );

    return res.json({
      ok: true,
      venta: ventaResultado.rows[0],
      detalle: detalleResultado.rows,
      pagos: pagosResultado.rows,
      lotes: lotesResultado.rows,
    });
  } catch (error) {
    console.error('Error al obtener venta:', error);

    return res.status(500).json({
      ok: false,
      mensaje: 'Error interno al obtener venta',
    });
  }
};


export const devolverVenta = async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;
    const {
      productos,
      motivo,
      observaciones,
    } = req.body;

    if (!Array.isArray(productos) || productos.length === 0) {
      return res.status(400).json({
        ok: false,
        mensaje:
          'Debes enviar al menos un producto para devolver',
      });
    }

    if (!motivo || !String(motivo).trim()) {
      return res.status(400).json({
        ok: false,
        mensaje:
          'El motivo de la devolución es obligatorio',
      });
    }

    await client.query('BEGIN');

    const ventaResultado = await client.query(
      `
      SELECT
        id_venta,
        folio,
        id_sucursal,
        id_caja,
        id_sesion,
        subtotal,
        descuento,
        impuesto,
        total,
        metodo_pago,
        estado
      FROM ventas
      WHERE id_venta = $1
      FOR UPDATE
      `,
      [id]
    );

    if (ventaResultado.rows.length === 0) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        ok: false,
        mensaje: 'Venta no encontrada',
      });
    }

    const venta = ventaResultado.rows[0];

    const accesoCaja = await validarAccesoCajaAsignada({
      db: client,
      usuario: req.usuario,
      idCaja: venta.id_caja,
      idSucursal: venta.id_sucursal,
      bloquear: true,
    });

    if (!accesoCaja.ok) {
      await client.query('ROLLBACK');
      return responderAccesoCajaDenegado(
        res,
        accesoCaja
      );
    }

    const estadoVenta = String(
      venta.estado || ''
    ).toUpperCase();

    if (
      !estadosVentaConDevolucionPermitida.includes(
        estadoVenta
      )
    ) {
      await client.query('ROLLBACK');

      return res.status(400).json({
        ok: false,
        mensaje:
          `No se puede devolver una venta con estado ${estadoVenta}`,
      });
    }

    const sesionResultado = await client.query(
      `
      SELECT
        id_sesion,
        estado
      FROM caja_sesiones
      WHERE id_sesion = $1
      `,
      [venta.id_sesion]
    );

    if (sesionResultado.rows.length === 0) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        ok: false,
        mensaje:
          'No se encontró la sesión de caja de la venta',
      });
    }

    if (
      sesionResultado.rows[0].estado !== 'ABIERTA'
    ) {
      await client.query('ROLLBACK');

      return res.status(400).json({
        ok: false,
        mensaje:
          'La caja de esta venta ya está cerrada. Por ahora solo se permiten devoluciones de ventas de la caja abierta.',
      });
    }

    let montoDevueltoTotal = 0;
    const detallesDevueltos = [];

    /*
     * Primero validamos todos los renglones solicitados.
     *
     * Importante:
     * venta_detalle.id_variante puede contener una variante histórica
     * generada por una migración, aun cuando el producto actualmente
     * NO use variantes. La fuente de verdad es productos.usa_variantes.
     */
    for (const item of productos) {
      const idDetalle = Number(item.id_detalle);
      const cantidadSolicitada = Number(
        item.cantidad || 0
      );

      if (
        !idDetalle ||
        cantidadSolicitada <= 0
      ) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          ok: false,
          mensaje:
            'Cada producto debe incluir id_detalle y cantidad mayor a cero',
        });
      }

      const detalleResultado = await client.query(
        `
        SELECT
          vd.id_detalle,
          vd.id_venta,
          vd.id_producto,

          vd.id_variante AS id_variante_historica,

          CASE
            WHEN COALESCE(p.usa_variantes, false) = true
              THEN vd.id_variante
            ELSE NULL
          END AS id_variante,

          p.usa_variantes,
          p.controla_lotes,
          vd.id_lote,

          p.nombre AS producto,

          CASE
            WHEN COALESCE(p.usa_variantes, false) = true
              THEN pv.nombre_variante
            ELSE NULL
          END AS nombre_variante,

          vd.cantidad,
          vd.precio_unitario,
          vd.subtotal

        FROM venta_detalle vd

        INNER JOIN productos p
          ON p.id_producto = vd.id_producto

        LEFT JOIN producto_variantes pv
          ON pv.id_variante = vd.id_variante
         AND COALESCE(p.usa_variantes, false) = true

        WHERE vd.id_detalle = $1
          AND vd.id_venta = $2

        FOR UPDATE OF vd
        `,
        [
          idDetalle,
          venta.id_venta,
        ]
      );

      if (
        detalleResultado.rows.length === 0
      ) {
        await client.query('ROLLBACK');

        return res.status(404).json({
          ok: false,
          mensaje:
            `No se encontró el detalle de venta ${idDetalle}`,
        });
      }

      const detalle =
        detalleResultado.rows[0];

      const usaVariantes = esValorActivo(
        detalle.usa_variantes
      );

      const controlaLotes = esValorActivo(
        detalle.controla_lotes
      );

      const idVarianteEfectiva =
        usaVariantes &&
        Number(detalle.id_variante || 0) > 0
          ? Number(detalle.id_variante)
          : null;

      const devueltoResultado =
        await client.query(
          `
          SELECT
            COALESCE(
              SUM(cantidad_devuelta),
              0
            )::numeric(12,2) AS cantidad_devuelta
          FROM ventas_devoluciones_detalle
          WHERE id_detalle = $1
          `,
          [idDetalle]
        );

      const cantidadVendida = Number(
        detalle.cantidad || 0
      );

      const cantidadYaDevuelta = Number(
        devueltoResultado.rows[0]
          ?.cantidad_devuelta || 0
      );

      const cantidadDisponible =
        cantidadVendida -
        cantidadYaDevuelta;

      if (
        cantidadSolicitada >
        cantidadDisponible
      ) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          ok: false,
          mensaje:
            `No puedes devolver ${cantidadSolicitada} de ${detalle.producto}. Disponible para devolver: ${cantidadDisponible}`,
        });
      }

      const subtotalDetalle = Number(
        detalle.subtotal || 0
      );

      const totalVenta = Number(
        venta.total || 0
      );

      const subtotalVenta = Number(
        venta.subtotal || 0
      );

      const factorTotalVenta =
        subtotalVenta > 0
          ? totalVenta / subtotalVenta
          : 1;

      const precioProporcionalSubtotal =
        redondearDos(
          subtotalDetalle /
          cantidadVendida
        );

      const subtotalDevuelto =
        redondearDos(
          precioProporcionalSubtotal *
          cantidadSolicitada
        );

      const totalDevueltoConImpuesto =
        redondearDos(
          subtotalDevuelto *
          factorTotalVenta
        );

      montoDevueltoTotal +=
        totalDevueltoConImpuesto;

      detallesDevueltos.push({
        id_detalle:
          detalle.id_detalle,

        id_producto:
          detalle.id_producto,

        id_variante:
          idVarianteEfectiva,

        usa_variantes:
          usaVariantes,

        controla_lotes:
          controlaLotes,

        id_lote:
          detalle.id_lote
            ? Number(detalle.id_lote)
            : null,

        producto:
          usaVariantes &&
          detalle.nombre_variante
            ? `${detalle.producto} · ${detalle.nombre_variante}`
            : detalle.producto,

        cantidad_devuelta:
          cantidadSolicitada,

        precio_unitario:
          precioProporcionalSubtotal,

        subtotal_devuelto:
          subtotalDevuelto,
      });
    }

    montoDevueltoTotal =
      redondearDos(
        montoDevueltoTotal
      );

    if (montoDevueltoTotal <= 0) {
      await client.query('ROLLBACK');

      return res.status(400).json({
        ok: false,
        mensaje:
          'El monto de la devolución debe ser mayor a cero',
      });
    }

    const folioDevolucion =
      generarFolioDevolucion();

    const devolucionResultado =
      await client.query(
        `
        INSERT INTO ventas_devoluciones (
          id_venta,
          id_sesion,
          id_sucursal,
          id_usuario,
          folio_devolucion,
          metodo_pago_original,
          monto_devuelto,
          motivo,
          observaciones,
          estado
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,
          'APLICADA'
        )
        RETURNING *
        `,
        [
          venta.id_venta,
          venta.id_sesion,
          venta.id_sucursal,
          req.usuario.id_usuario,
          folioDevolucion,
          venta.metodo_pago,
          montoDevueltoTotal,
          motivo.trim(),
          observaciones
            ? observaciones.trim()
            : null,
        ]
      );

    const devolucion =
      devolucionResultado.rows[0];

    /*
     * Helpers locales de devolución.
     */
    const restituirInventarioVariante =
      async ({
        detalle,
        cantidad,
      }) => {
        if (
          !detalle.usa_variantes ||
          !detalle.id_variante
        ) {
          return;
        }

        const resultado =
          await client.query(
            `
            SELECT
              id_inventario_variante,
              stock_actual
            FROM inventario_variantes_sucursal
            WHERE id_sucursal = $1
              AND id_producto = $2
              AND id_variante = $3
            FOR UPDATE
            `,
            [
              venta.id_sucursal,
              detalle.id_producto,
              detalle.id_variante,
            ]
          );

        if (
          resultado.rows.length === 0
        ) {
          await client.query('ROLLBACK');

          const error = new Error(
            `No se encontró el inventario de la variante para ${detalle.producto}`
          );

          error.statusCode = 404;
          throw error;
        }

        const stockAnterior = Number(
          resultado.rows[0]
            .stock_actual || 0
        );

        const stockNuevo =
          redondearDos(
            stockAnterior +
            Number(cantidad || 0)
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
            stockNuevo,
            resultado.rows[0]
              .id_inventario_variante,
          ]
        );
      };

    const restituirInventarioSucursal =
      async ({
        detalle,
        cantidad,
      }) => {
        const resultado =
          await client.query(
            `
            SELECT
              id_inventario,
              stock_actual
            FROM inventario_sucursal
            WHERE id_sucursal = $1
              AND id_producto = $2
            FOR UPDATE
            `,
            [
              venta.id_sucursal,
              detalle.id_producto,
            ]
          );

        if (
          resultado.rows.length === 0
        ) {
          await client.query('ROLLBACK');

          const error = new Error(
            `No se encontró inventario de sucursal para ${detalle.producto}`
          );

          error.statusCode = 404;
          throw error;
        }

        const stockAnterior = Number(
          resultado.rows[0]
            .stock_actual || 0
        );

        const stockNuevo =
          redondearDos(
            stockAnterior +
            Number(cantidad || 0)
          );

        await client.query(
          `
          UPDATE inventario_sucursal
          SET
            stock_actual = $1,
            fecha_actualizacion = CURRENT_TIMESTAMP
          WHERE id_inventario = $2
          `,
          [
            stockNuevo,
            resultado.rows[0]
              .id_inventario,
          ]
        );

        return {
          stock_anterior:
            stockAnterior,
          stock_nuevo:
            stockNuevo,
        };
      };

    const registrarDetalleDevolucion =
      async ({
        detalle,
        idLote = null,
        cantidad,
        stockSucursalAnterior,
        stockSucursalNuevo,
      }) => {
        const subtotalParcial =
          redondearDos(
            detalle.precio_unitario *
            Number(cantidad || 0)
          );

        await client.query(
          `
          INSERT INTO ventas_devoluciones_detalle (
            id_devolucion,
            id_venta,
            id_detalle,
            id_producto,
            id_variante,
            id_lote,
            producto,
            cantidad_devuelta,
            precio_unitario,
            subtotal_devuelto
          )
          VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
          )
          `,
          [
            devolucion.id_devolucion,
            venta.id_venta,
            detalle.id_detalle,
            detalle.id_producto,
            detalle.id_variante,
            idLote,
            detalle.producto,
            Number(cantidad || 0),
            detalle.precio_unitario,
            subtotalParcial,
          ]
        );

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
          VALUES (
            $1,$2,$3,$4,
            'DEVOLUCION_VENTA',
            $5,$6,$7,$8,$9,$10
          )
          `,
          [
            venta.id_sucursal,
            detalle.id_producto,
            detalle.id_variante,
            idLote,
            Number(cantidad || 0),
            stockSucursalAnterior,
            stockSucursalNuevo,
            folioDevolucion,
            `Devolución ${folioDevolucion} de venta ${venta.folio} | ${motivo.trim()}`,
            req.usuario.id_usuario,
          ]
        );
      };

    /*
     * Restituimos inventario.
     */
    for (
      const detalle of
      detallesDevueltos
    ) {
      let cantidadPendienteRestituir =
        Number(
          detalle.cantidad_devuelta
        );

      /*
       * PRODUCTO SIN CONTROL DE LOTES
       *
       * No depende de inventario_movimientos de tipo VENTA,
       * porque las ventas sin lote no generan un movimiento
       * por lote en la implementación actual.
       */
      if (!detalle.controla_lotes) {
        await restituirInventarioVariante({
          detalle,
          cantidad:
            cantidadPendienteRestituir,
        });

        const stockSucursal =
          await restituirInventarioSucursal({
            detalle,
            cantidad:
              cantidadPendienteRestituir,
          });

        await registrarDetalleDevolucion({
          detalle,
          idLote: null,
          cantidad:
            cantidadPendienteRestituir,
          stockSucursalAnterior:
            stockSucursal.stock_anterior,
          stockSucursalNuevo:
            stockSucursal.stock_nuevo,
        });

        cantidadPendienteRestituir = 0;
        continue;
      }

      /*
       * PRODUCTO CON CONTROL DE LOTES
       *
       * Para una venta con lote seleccionado, venta_detalle.id_lote
       * permite identificar exactamente el lote que debe restituirse.
       * Si id_lote quedó NULL (por ejemplo una venta FEFO histórica),
       * se recuperan todos los movimientos de ese producto/variante.
       *
       * Para productos SIN variantes NO filtramos por id_variante:
       * esto permite devolver ventas antiguas cuyos registros recibieron
       * una variante principal durante la migración.
       */
      const paramsMovimientos = [
        venta.folio,
        detalle.id_producto,
      ];

      let queryMovimientos = `
        SELECT
          im.id_movimiento,
          im.id_lote,
          im.id_variante,
          il.lote,
          im.cantidad,
          im.stock_nuevo
        FROM inventario_movimientos im
        LEFT JOIN inventario_lotes il
          ON il.id_lote = im.id_lote
        WHERE im.referencia = $1
          AND im.tipo_movimiento = 'VENTA'
          AND im.id_producto = $2
      `;

      if (detalle.id_lote) {
        paramsMovimientos.push(
          detalle.id_lote
        );

        queryMovimientos += `
          AND im.id_lote IS NOT DISTINCT FROM
              $${paramsMovimientos.length}::bigint
        `;
      }

      if (
        detalle.usa_variantes &&
        detalle.id_variante
      ) {
        paramsMovimientos.push(
          detalle.id_variante
        );

        queryMovimientos += `
          AND im.id_variante IS NOT DISTINCT FROM
              $${paramsMovimientos.length}::integer
        `;
      }

      queryMovimientos += `
        ORDER BY
          im.fecha_movimiento ASC,
          im.id_movimiento ASC
      `;

      const lotesVentaResultado =
        await client.query(
          queryMovimientos,
          paramsMovimientos
        );

      /*
       * Compatibilidad extra:
       * si la venta es histórica y venta_detalle.id_lote apunta a un
       * dato que ya fue normalizado, intentamos de nuevo sin ese filtro.
       */
      let movimientosVenta =
        lotesVentaResultado.rows;

      if (
        movimientosVenta.length === 0 &&
        detalle.id_lote &&
        !detalle.usa_variantes
      ) {
        const fallback =
          await client.query(
            `
            SELECT
              im.id_movimiento,
              im.id_lote,
              im.id_variante,
              il.lote,
              im.cantidad,
              im.stock_nuevo
            FROM inventario_movimientos im
            LEFT JOIN inventario_lotes il
              ON il.id_lote = im.id_lote
            WHERE im.referencia = $1
              AND im.tipo_movimiento = 'VENTA'
              AND im.id_producto = $2
            ORDER BY
              im.fecha_movimiento ASC,
              im.id_movimiento ASC
            `,
            [
              venta.folio,
              detalle.id_producto,
            ]
          );

        movimientosVenta =
          fallback.rows;
      }

      if (
        movimientosVenta.length === 0
      ) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          ok: false,
          mensaje:
            `No se encontraron movimientos de inventario de venta para ${detalle.producto}`,
        });
      }

      for (
        const loteVenta of
        movimientosVenta
      ) {
        if (
          cantidadPendienteRestituir <= 0
        ) {
          break;
        }

        if (!loteVenta.id_lote) {
          continue;
        }

        /*
         * Calculamos cuánto de ESTE detalle/lote ya fue devuelto.
         * Usar id_detalle evita mezclar devoluciones de dos renglones
         * del mismo producto.
         */
        const devueltoPorLoteResultado =
          await client.query(
            `
            SELECT
              COALESCE(
                SUM(cantidad_devuelta),
                0
              )::numeric(12,2) AS cantidad_devuelta
            FROM ventas_devoluciones_detalle
            WHERE id_venta = $1
              AND id_detalle = $2
              AND id_lote IS NOT DISTINCT FROM $3::bigint
            `,
            [
              venta.id_venta,
              detalle.id_detalle,
              loteVenta.id_lote,
            ]
          );

        const cantidadLoteVendida =
          Number(
            loteVenta.cantidad || 0
          );

        const cantidadLoteYaDevuelta =
          Number(
            devueltoPorLoteResultado
              .rows[0]
              ?.cantidad_devuelta || 0
          );

        const cantidadLoteDisponible =
          cantidadLoteVendida -
          cantidadLoteYaDevuelta;

        if (
          cantidadLoteDisponible <= 0
        ) {
          continue;
        }

        const cantidadARestituir =
          Math.min(
            cantidadPendienteRestituir,
            cantidadLoteDisponible
          );

        const paramsLote = [
          loteVenta.id_lote,
          venta.id_sucursal,
          detalle.id_producto,
        ];

        let queryLote = `
          SELECT
            id_lote,
            id_sucursal,
            id_producto,
            id_variante,
            stock_actual
          FROM inventario_lotes
          WHERE id_lote = $1
            AND id_sucursal = $2
            AND id_producto = $3
        `;

        /*
         * Solo exigimos variante cuando el producto realmente la usa.
         */
        if (
          detalle.usa_variantes &&
          detalle.id_variante
        ) {
          paramsLote.push(
            detalle.id_variante
          );

          queryLote += `
            AND id_variante IS NOT DISTINCT FROM
                $${paramsLote.length}::integer
          `;
        }

        queryLote += `
          FOR UPDATE
        `;

        const loteActualResultado =
          await client.query(
            queryLote,
            paramsLote
          );

        if (
          loteActualResultado.rows.length === 0
        ) {
          await client.query('ROLLBACK');

          return res.status(404).json({
            ok: false,
            mensaje:
              `No se encontró el lote para restituir ${detalle.producto}`,
          });
        }

        const stockLoteAnterior =
          Number(
            loteActualResultado.rows[0]
              .stock_actual || 0
          );

        const stockLoteNuevo =
          redondearDos(
            stockLoteAnterior +
            cantidadARestituir
          );

        await client.query(
          `
          UPDATE inventario_lotes
          SET
            stock_actual = $1,
            activo = true,
            fecha_actualizacion = CURRENT_TIMESTAMP
          WHERE id_lote = $2
          `,
          [
            stockLoteNuevo,
            loteVenta.id_lote,
          ]
        );

        /*
         * SOLO restituimos inventario de variante si el producto
         * realmente usa variantes.
         */
        await restituirInventarioVariante({
          detalle,
          cantidad:
            cantidadARestituir,
        });

        const stockSucursal =
          await restituirInventarioSucursal({
            detalle,
            cantidad:
              cantidadARestituir,
          });

        await registrarDetalleDevolucion({
          detalle,
          idLote:
            loteVenta.id_lote,
          cantidad:
            cantidadARestituir,
          stockSucursalAnterior:
            stockSucursal.stock_anterior,
          stockSucursalNuevo:
            stockSucursal.stock_nuevo,
        });

        cantidadPendienteRestituir =
          redondearDos(
            cantidadPendienteRestituir -
            cantidadARestituir
          );
      }

      if (
        cantidadPendienteRestituir > 0
      ) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          ok: false,
          mensaje:
            `No se pudo restituir completamente ${detalle.producto}. Pendiente: ${cantidadPendienteRestituir}`,
        });
      }
    }

    const totalVendidoResultado =
      await client.query(
        `
        SELECT
          COALESCE(
            SUM(cantidad),
            0
          )::numeric(12,2) AS cantidad_vendida
        FROM venta_detalle
        WHERE id_venta = $1
        `,
        [venta.id_venta]
      );

    const totalDevueltoResultado =
      await client.query(
        `
        SELECT
          COALESCE(
            SUM(cantidad_devuelta),
            0
          )::numeric(12,2) AS cantidad_devuelta
        FROM ventas_devoluciones_detalle
        WHERE id_venta = $1
        `,
        [venta.id_venta]
      );

    const cantidadVendidaTotal =
      Number(
        totalVendidoResultado.rows[0]
          ?.cantidad_vendida || 0
      );

    const cantidadDevueltaTotal =
      Number(
        totalDevueltoResultado.rows[0]
          ?.cantidad_devuelta || 0
      );

    const nuevoEstadoVenta =
      cantidadDevueltaTotal >=
      cantidadVendidaTotal
        ? 'DEVUELTA'
        : 'DEVUELTA_PARCIAL';

    const ventaActualizadaResultado =
      await client.query(
        `
        UPDATE ventas
        SET estado = $1
        WHERE id_venta = $2
        RETURNING *
        `,
        [
          nuevoEstadoVenta,
          venta.id_venta,
        ]
      );

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
      VALUES (
        $1,$2,'DEVOLUCION_VENTA',
        $3,$4,$5,$6,$7,$8
      )
      `,
      [
        venta.id_sesion,
        venta.id_sucursal,
        `Devolución de venta ${venta.folio}`,
        montoDevueltoTotal,
        venta.metodo_pago,
        folioDevolucion,
        `Devolución ligada a venta ${venta.folio} | Motivo: ${motivo.trim()}`,
        req.usuario.id_usuario,
      ]
    );

    await client.query('COMMIT');

    return res.status(201).json({
      ok: true,
      mensaje:
        'Devolución aplicada correctamente',
      devolucion,
      venta:
        ventaActualizadaResultado.rows[0],
      resumen: {
        folio_devolucion:
          folioDevolucion,
        folio_venta:
          venta.folio,
        metodo_pago_original:
          venta.metodo_pago,
        monto_devuelto:
          montoDevueltoTotal,
        estado_venta:
          nuevoEstadoVenta,
      },
    });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Si la transacción ya fue revertida, no hacemos nada.
    }

    console.error(
      'Error al devolver venta:',
      error
    );

    return res
      .status(error.statusCode || 500)
      .json({
        ok: false,
        mensaje:
          error.message ||
          'Error interno al devolver venta',
      });
  } finally {
    client.release();
  }
};


export const listarVentasServiciosClinicos = async (req, res) => {
  return res.status(410).json({
    ok: false,
    mensaje: 'El módulo de servicios clínicos ya no está disponible',
    ventas_servicios: [],
    resumen: {
      total_registros: 0,
      total_ventas: 0,
      total_cantidad_servicios: 0,
      subtotal_servicios: 0,
    },
  });
};

export const cancelarServicioClinicoPendiente = async (req, res) => {
  return res.status(410).json({
    ok: false,
    mensaje: 'El módulo de servicios clínicos ya no está disponible',
  });
};
