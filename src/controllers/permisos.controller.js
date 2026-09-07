import { pool } from '../config/db.js';

/**
 * GET /api/permisos
 *
 * Devuelve los permisos activos agrupados por rol.
 *
 * Ejemplo:
 * {
 *   "ROOT": ["dashboard", "productos", ...],
 *   "SUPER_ADMIN": ["dashboard", "productos", ...],
 *   "CAJERO": ["pos", "caja", ...]
 * }
 */
export const obtenerPermisos = async (req, res) => {
  try {
    const resultado = await pool.query(`
      SELECT
        pr.rol,
        ms.clave
      FROM permisos_roles pr
      INNER JOIN modulos_sistema ms
        ON ms.id = pr.modulo_id
      WHERE pr.permitido = TRUE
        AND ms.activo = TRUE
      ORDER BY pr.rol, ms.orden, ms.nombre
    `);

    const permisos = {};

    for (const fila of resultado.rows) {
      if (!permisos[fila.rol]) {
        permisos[fila.rol] = [];
      }

      permisos[fila.rol].push(fila.clave);
    }

    return res.json(permisos);
  } catch (error) {
    console.error('Error al obtener permisos:', error);

    return res.status(500).json({
      ok: false,
      message: 'Error al obtener los permisos',
    });
  }
};


/**
 * GET /api/permisos/modulos
 *
 * Devuelve todos los módulos activos del sistema.
 * Se utilizará para construir la pantalla de configuración.
 */
export const obtenerModulos = async (req, res) => {
  try {
    const resultado = await pool.query(`
      SELECT
        id,
        clave,
        nombre,
        descripcion,
        orden,
        activo
      FROM modulos_sistema
      WHERE activo = TRUE
      ORDER BY orden, nombre
    `);

    return res.json(resultado.rows);
  } catch (error) {
    console.error('Error al obtener módulos:', error);

    return res.status(500).json({
      ok: false,
      message: 'Error al obtener los módulos',
    });
  }
};


/**
 * GET /api/permisos/:rol
 *
 * Devuelve únicamente los permisos habilitados para un rol.
 *
 * Ejemplo:
 * GET /api/permisos/CAJERO
 *
 * {
 *   "rol": "CAJERO",
 *   "permisos": [
 *      "pos",
 *      "caja",
 *      "ventas"
 *   ]
 * }
 */
export const obtenerPermisosPorRol = async (req, res) => {
  try {
    const rol = req.params.rol?.trim().toUpperCase();

    if (!rol) {
      return res.status(400).json({
        ok: false,
        message: 'Debe indicar un rol',
      });
    }

    const resultado = await pool.query(
      `
      SELECT
        ms.clave,
        ms.nombre,
        ms.descripcion,
        ms.orden
      FROM permisos_roles pr
      INNER JOIN modulos_sistema ms
        ON ms.id = pr.modulo_id
      WHERE pr.rol = $1
        AND pr.permitido = TRUE
        AND ms.activo = TRUE
      ORDER BY ms.orden, ms.nombre
      `,
      [rol]
    );

    return res.json({
      rol,
      permisos: resultado.rows.map((fila) => fila.clave),
    });
  } catch (error) {
    console.error('Error al obtener permisos por rol:', error);

    return res.status(500).json({
      ok: false,
      message: 'Error al obtener los permisos del rol',
    });
  }
};


/**
 * GET /api/permisos/configuracion/:rol
 *
 * Devuelve TODOS los módulos y señala cuáles están habilitados.
 *
 * Esto es especialmente útil para la pantalla de configuración.
 *
 * Ejemplo:
 *
 * [
 *   {
 *     "id": 1,
 *     "clave": "dashboard",
 *     "nombre": "Dashboard",
 *     "permitido": true
 *   },
 *   {
 *     "id": 2,
 *     "clave": "productos",
 *     "nombre": "Productos",
 *     "permitido": false
 *   }
 * ]
 */
export const obtenerConfiguracionPorRol = async (req, res) => {
  try {
    const rol = req.params.rol?.trim().toUpperCase();

    if (!rol) {
      return res.status(400).json({
        ok: false,
        message: 'Debe indicar un rol',
      });
    }

    const resultado = await pool.query(
      `
      SELECT
        ms.id,
        ms.clave,
        ms.nombre,
        ms.descripcion,
        ms.orden,
        CASE
          WHEN pr.id IS NOT NULL AND pr.permitido = TRUE
          THEN TRUE
          ELSE FALSE
        END AS permitido
      FROM modulos_sistema ms
      LEFT JOIN permisos_roles pr
        ON pr.modulo_id = ms.id
        AND pr.rol = $1
      WHERE ms.activo = TRUE
      ORDER BY ms.orden, ms.nombre
      `,
      [rol]
    );

    return res.json({
      rol,
      modulos: resultado.rows,
    });
  } catch (error) {
    console.error('Error obteniendo configuración del rol:', error);

    return res.status(500).json({
      ok: false,
      message: 'Error al obtener la configuración de permisos',
    });
  }
};


/**
 * PUT /api/permisos/:rol
 *
 * Body:
 *
 * {
 *   "permisos": [
 *      "dashboard",
 *      "productos",
 *      "inventario"
 *   ]
 * }
 *
 * Reemplaza completamente los permisos actuales del rol.
 */
export const actualizarPermisosRol = async (req, res) => {
  const rol = req.params.rol?.trim().toUpperCase();
  const { permisos } = req.body;

  if (!rol) {
    return res.status(400).json({
      ok: false,
      message: 'Debe indicar un rol',
    });
  }

  /*
   * ROOT no se modifica.
   * De esta manera evitamos bloquear accidentalmente
   * al usuario con acceso absoluto al sistema.
   */
  if (rol === 'ROOT') {
    return res.status(403).json({
      ok: false,
      message: 'Los permisos del rol ROOT no pueden modificarse',
    });
  }

  if (!Array.isArray(permisos)) {
    return res.status(400).json({
      ok: false,
      message: 'El campo permisos debe ser un arreglo',
    });
  }

  /*
   * Eliminamos duplicados y valores inválidos.
   */
  const permisosLimpios = [
    ...new Set(
      permisos
        .filter(
          (permiso) =>
            typeof permiso === 'string' &&
            permiso.trim().length > 0
        )
        .map((permiso) => permiso.trim())
    ),
  ];

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    /*
     * Validamos que todos los módulos enviados existan.
     */
    if (permisosLimpios.length > 0) {
      const modulosExistentes = await client.query(
        `
        SELECT clave
        FROM modulos_sistema
        WHERE clave = ANY($1::text[])
          AND activo = TRUE
        `,
        [permisosLimpios]
      );

      const clavesExistentes = modulosExistentes.rows.map(
        (fila) => fila.clave
      );

      const permisosInvalidos = permisosLimpios.filter(
        (clave) => !clavesExistentes.includes(clave)
      );

      if (permisosInvalidos.length > 0) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          ok: false,
          message: 'Se enviaron módulos que no existen',
          modulosInvalidos: permisosInvalidos,
        });
      }
    }

    /*
     * Eliminamos la configuración anterior.
     */
    await client.query(
      `
      DELETE FROM permisos_roles
      WHERE rol = $1
      `,
      [rol]
    );

    /*
     * Insertamos los nuevos permisos.
     */
    if (permisosLimpios.length > 0) {
      await client.query(
        `
        INSERT INTO permisos_roles (
          rol,
          modulo_id,
          permitido
        )
        SELECT
          $1,
          ms.id,
          TRUE
        FROM modulos_sistema ms
        WHERE ms.clave = ANY($2::text[])
          AND ms.activo = TRUE
        `,
        [rol, permisosLimpios]
      );
    }

    await client.query('COMMIT');

    return res.json({
      ok: true,
      message: `Permisos de ${rol} actualizados correctamente`,
      rol,
      permisos: permisosLimpios,
    });
  } catch (error) {
    await client.query('ROLLBACK');

    console.error('Error actualizando permisos:', error);

    return res.status(500).json({
      ok: false,
      message: 'Error al actualizar los permisos',
    });
  } finally {
    client.release();
  }
};