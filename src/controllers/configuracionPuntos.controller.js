import { pool } from '../config/db.js';

const normalizarBooleano = (valor, valorDefault = true) => {
  if (valor === undefined || valor === null) {
    return valorDefault;
  }

  if (typeof valor === 'boolean') {
    return valor;
  }

  if (typeof valor === 'string') {
    const texto = valor.trim().toLowerCase();

    if (['true', '1', 'si', 'sí', 's'].includes(texto)) {
      return true;
    }

    if (['false', '0', 'no', 'n'].includes(texto)) {
      return false;
    }
  }

  return Boolean(valor);
};

const normalizarPorcentaje = (valor, nombreCampo) => {
  const numero = Number(valor);

  if (Number.isNaN(numero)) {
    throw new Error(`${nombreCampo} debe ser un número válido`);
  }

  if (numero < 0) {
    throw new Error(`${nombreCampo} no puede ser negativo`);
  }

  if (numero > 100) {
    throw new Error(`${nombreCampo} no puede ser mayor a 100`);
  }

  return Number(numero.toFixed(2));
};

const obtenerConfiguracionActualInterna = async () => {
  const resultado = await pool.query(
    `
      SELECT
        id_configuracion,
        porcentaje_cliente,
        porcentaje_cajero,
        puntos_cliente_activo,
        puntos_cajero_activo,
        fecha_actualizacion,
        id_usuario_actualizacion
      FROM configuracion_puntos
      ORDER BY id_configuracion DESC
      LIMIT 1
    `
  );

  if (resultado.rows.length > 0) {
    return resultado.rows[0];
  }

  const creada = await pool.query(
    `
      INSERT INTO configuracion_puntos (
        porcentaje_cliente,
        porcentaje_cajero,
        puntos_cliente_activo,
        puntos_cajero_activo
      )
      VALUES (
        1.00,
        0.50,
        true,
        true
      )
      RETURNING *
    `
  );

  return creada.rows[0];
};

export const obtenerConfiguracionPuntos = async (req, res) => {
  try {
    const configuracion = await obtenerConfiguracionActualInterna();

    return res.json({
      ok: true,
      configuracion,
    });
  } catch (error) {
    console.error('Error al obtener configuración de puntos:', error);

    return res.status(500).json({
      ok: false,
      mensaje: 'Error interno al obtener configuración de puntos',
    });
  }
};

export const actualizarConfiguracionPuntos = async (req, res) => {
  try {
    const {
      porcentaje_cliente,
      porcentaje_cajero,
      puntos_cliente_activo,
      puntos_cajero_activo,
    } = req.body;

    const configuracionActual = await obtenerConfiguracionActualInterna();

    const porcentajeCliente =
      porcentaje_cliente === undefined ||
      porcentaje_cliente === null ||
      porcentaje_cliente === ''
        ? Number(configuracionActual.porcentaje_cliente)
        : normalizarPorcentaje(
            porcentaje_cliente,
            'El porcentaje del cliente'
          );

    const porcentajeCajero =
      porcentaje_cajero === undefined ||
      porcentaje_cajero === null ||
      porcentaje_cajero === ''
        ? Number(configuracionActual.porcentaje_cajero)
        : normalizarPorcentaje(
            porcentaje_cajero,
            'El porcentaje del cajero'
          );

    const puntosClienteActivo = normalizarBooleano(
      puntos_cliente_activo,
      configuracionActual.puntos_cliente_activo
    );

    const puntosCajeroActivo = normalizarBooleano(
      puntos_cajero_activo,
      configuracionActual.puntos_cajero_activo
    );

    const resultado = await pool.query(
      `
        UPDATE configuracion_puntos
        SET
          porcentaje_cliente = $1,
          porcentaje_cajero = $2,
          puntos_cliente_activo = $3,
          puntos_cajero_activo = $4,
          fecha_actualizacion = CURRENT_TIMESTAMP,
          id_usuario_actualizacion = $5
        WHERE id_configuracion = $6
        RETURNING *
      `,
      [
        porcentajeCliente,
        porcentajeCajero,
        puntosClienteActivo,
        puntosCajeroActivo,
        req.usuario?.id_usuario || null,
        configuracionActual.id_configuracion,
      ]
    );

    return res.json({
      ok: true,
      mensaje: 'Configuración de puntos actualizada correctamente',
      configuracion: resultado.rows[0],
    });
  } catch (error) {
    console.error('Error al actualizar configuración de puntos:', error);

    return res.status(400).json({
      ok: false,
      mensaje:
        error.message ||
        'No se pudo actualizar la configuración de puntos',
    });
  }
};

export const obtenerSaldoPuntosCajero = async (req, res) => {
  try {
    const { id_usuario } = req.params;

    if (!id_usuario) {
      return res.status(400).json({
        ok: false,
        mensaje: 'El id del usuario es obligatorio',
      });
    }

    const idUsuario = Number(id_usuario);

    if (!Number.isInteger(idUsuario) || idUsuario <= 0) {
      return res.status(400).json({
        ok: false,
        mensaje: 'El id del usuario no es válido',
      });
    }

    const usuarioResultado = await pool.query(
      `
        SELECT
          u.id_usuario,
          u.nombre,
          u.usuario,
          r.nombre AS rol,
          u.activo
        FROM usuarios u
        LEFT JOIN roles r
          ON r.id_rol = u.id_rol
        WHERE u.id_usuario = $1
        LIMIT 1
      `,
      [idUsuario]
    );

    if (usuarioResultado.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        mensaje: 'El usuario no existe',
      });
    }

    const saldoResultado = await pool.query(
      `
        SELECT
          COALESCE(SUM(puntos), 0)::numeric(12,2) AS saldo_puntos,
          COUNT(*)::int AS total_movimientos
        FROM cajeros_puntos_movimientos
        WHERE id_usuario = $1
      `,
      [idUsuario]
    );

    return res.json({
      ok: true,
      usuario: usuarioResultado.rows[0],
      saldo: saldoResultado.rows[0],
    });
  } catch (error) {
    console.error('Error al obtener saldo de puntos del cajero:', error);

    return res.status(500).json({
      ok: false,
      mensaje: 'Error interno al obtener saldo de puntos del cajero',
    });
  }
};

export const listarMovimientosPuntosCajero = async (req, res) => {
  try {
    const {
      id_usuario,
      fecha_inicio,
      fecha_fin,
      limite = 100,
    } = req.query;

    let query = `
      SELECT
        m.id_movimiento,
        m.id_usuario,
        u.nombre AS cajero,
        u.usuario,
        r.nombre AS rol,
        m.id_venta,
        v.folio,
        m.tipo_movimiento,
        m.puntos,
        m.porcentaje_aplicado,
        m.monto_base,
        m.descripcion,
        m.fecha_movimiento
      FROM cajeros_puntos_movimientos m
      INNER JOIN usuarios u
        ON u.id_usuario = m.id_usuario
      LEFT JOIN roles r
        ON r.id_rol = u.id_rol
      LEFT JOIN ventas v
        ON v.id_venta = m.id_venta
      WHERE 1 = 1
    `;

    const params = [];

    if (id_usuario) {
      const idUsuario = Number(id_usuario);

      if (!Number.isInteger(idUsuario) || idUsuario <= 0) {
        return res.status(400).json({
          ok: false,
          mensaje: 'El id_usuario no es válido',
        });
      }

      params.push(idUsuario);
      query += ` AND m.id_usuario = $${params.length} `;
    }

    if (fecha_inicio) {
      params.push(fecha_inicio);
      query += `
        AND m.fecha_movimiento::date >= $${params.length}::date
      `;
    }

    if (fecha_fin) {
      params.push(fecha_fin);
      query += `
        AND m.fecha_movimiento::date <= $${params.length}::date
      `;
    }

    const limiteNumerico = Number.parseInt(limite, 10);

    const limiteSeguro =
      Number.isInteger(limiteNumerico) && limiteNumerico > 0
        ? Math.min(limiteNumerico, 500)
        : 100;

    params.push(limiteSeguro);

    query += `
      ORDER BY m.fecha_movimiento DESC
      LIMIT $${params.length}
    `;

    const resultado = await pool.query(query, params);

    return res.json({
      ok: true,
      movimientos: resultado.rows,
    });
  } catch (error) {
    console.error('Error al listar movimientos de puntos de cajeros:', error);

    return res.status(500).json({
      ok: false,
      mensaje: 'Error interno al listar movimientos de puntos de cajeros',
    });
  }
};

export const listarResumenPuntosCajeros = async (req, res) => {
  try {
    const resultado = await pool.query(
      `
        SELECT
          u.id_usuario,
          u.nombre,
          u.usuario,
          r.nombre AS rol,
          u.activo,
          COALESCE(SUM(m.puntos), 0)::numeric(12,2) AS saldo_puntos,
          COUNT(m.id_movimiento)::int AS total_movimientos,
          MAX(m.fecha_movimiento) AS ultimo_movimiento
        FROM usuarios u
        LEFT JOIN roles r
          ON r.id_rol = u.id_rol
        LEFT JOIN cajeros_puntos_movimientos m
          ON m.id_usuario = u.id_usuario
        WHERE u.activo = true
          AND UPPER(COALESCE(r.nombre, '')) IN ('CAJERO', 'VENDEDOR')
        GROUP BY
          u.id_usuario,
          u.nombre,
          u.usuario,
          r.nombre,
          u.activo
        ORDER BY
          saldo_puntos DESC,
          u.nombre ASC
      `
    );

    return res.json({
      ok: true,
      cajeros: resultado.rows,
    });
  } catch (error) {
    console.error('Error al listar resumen de puntos de cajeros:', error);

    return res.status(500).json({
      ok: false,
      mensaje: 'Error interno al listar resumen de puntos de cajeros',
    });
  }
};

export const canjearPuntosCajero = async (req, res) => {
  const client = await pool.connect();

  try {
    const { id_usuario } = req.params;
    const { descripcion } = req.body;

    if (!id_usuario) {
      return res.status(400).json({
        ok: false,
        mensaje: 'El id del usuario es obligatorio',
      });
    }

    const idUsuario = Number(id_usuario);

    if (!Number.isInteger(idUsuario) || idUsuario <= 0) {
      return res.status(400).json({
        ok: false,
        mensaje: 'El id del usuario no es válido',
      });
    }

    await client.query('BEGIN');

    const usuarioResultado = await client.query(
      `
        SELECT
          u.id_usuario,
          u.nombre,
          u.usuario,
          u.activo,
          r.nombre AS rol
        FROM usuarios u
        LEFT JOIN roles r
          ON r.id_rol = u.id_rol
        WHERE u.id_usuario = $1
        FOR UPDATE
      `,
      [idUsuario]
    );

    if (usuarioResultado.rows.length === 0) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        ok: false,
        mensaje: 'El usuario no existe',
      });
    }

    const usuario = usuarioResultado.rows[0];

    if (!usuario.activo) {
      await client.query('ROLLBACK');

      return res.status(400).json({
        ok: false,
        mensaje: 'El usuario está inactivo',
      });
    }

    if (
      !['CAJERO', 'VENDEDOR'].includes(
        String(usuario.rol || '').toUpperCase()
      )
    ) {
      await client.query('ROLLBACK');

      return res.status(400).json({
        ok: false,
        mensaje: 'El usuario no pertenece a un rol con puntos de venta',
      });
    }

    const saldoResultado = await client.query(
      `
        SELECT
          COALESCE(SUM(puntos), 0)::numeric(12,2) AS saldo_puntos
        FROM cajeros_puntos_movimientos
        WHERE id_usuario = $1
      `,
      [idUsuario]
    );

    const saldoActual = Number(
      saldoResultado.rows[0]?.saldo_puntos || 0
    );

    if (saldoActual <= 0) {
      await client.query('ROLLBACK');

      return res.status(400).json({
        ok: false,
        mensaje: 'El cajero no tiene puntos disponibles para canjear',
        saldo_puntos: saldoActual,
      });
    }

    const movimientoResultado = await client.query(
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
        VALUES (
          $1,
          NULL,
          'CANJE',
          $2,
          NULL,
          NULL,
          $3
        )
        RETURNING *
      `,
      [
        idUsuario,
        saldoActual * -1,
        descripcion ||
          `Canje/reinicio de ${saldoActual} puntos del cajero`,
      ]
    );

    await client.query('COMMIT');

    return res.json({
      ok: true,
      mensaje: 'Puntos del cajero canjeados correctamente',
      usuario,
      puntos_canjeados: saldoActual,
      movimiento: movimientoResultado.rows[0],
      saldo_nuevo: 0,
    });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {}

    console.error('Error al canjear puntos del cajero:', error);

    return res.status(500).json({
      ok: false,
      mensaje: 'Error interno al canjear puntos del cajero',
    });
  } finally {
    client.release();
  }
};
