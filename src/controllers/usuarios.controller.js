import bcrypt from 'bcryptjs';
import { pool } from '../config/db.js';

const ROLES_EXCLUIDOS = [
  'DOCTOR',
  'DOCTOR_SHADDAI',
  'MEDICO',
  'MÉDICO',
];

const normalizarBooleano = (valor, valorDefault = true) => {
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
  const numero = Number(valor);

  if (!Number.isInteger(numero) || numero <= 0) {
    return null;
  }

  return numero;
};

const normalizarSucursales = (sucursales) => {
  if (!Array.isArray(sucursales)) {
    return [];
  }

  return [
    ...new Set(
      sucursales
        .map((idSucursal) => normalizarId(idSucursal))
        .filter(Boolean)
    ),
  ];
};

const validarSucursales = async (client, sucursales) => {
  if (!sucursales.length) {
    return {
      ok: false,
      mensaje: 'Debes asignar al menos una sucursal',
    };
  }

  const resultado = await client.query(
    `
      SELECT id_sucursal
      FROM sucursales
      WHERE id_sucursal = ANY($1::int[])
        AND activo = true
    `,
    [sucursales]
  );

  const encontradas = new Set(
    resultado.rows.map((fila) => Number(fila.id_sucursal))
  );

  const faltantes = sucursales.filter(
    (idSucursal) => !encontradas.has(Number(idSucursal))
  );

  if (faltantes.length > 0) {
    return {
      ok: false,
      mensaje: 'Una o más sucursales seleccionadas no existen o están inactivas',
    };
  }

  return {
    ok: true,
  };
};

export const listarRoles = async (req, res) => {
  try {
    const resultado = await pool.query(
      `
        SELECT
          id_rol,
          nombre,
          descripcion,
          activo,
          fecha_creacion
        FROM roles
        WHERE activo = true
          AND UPPER(nombre) <> ALL($1::text[])
        ORDER BY id_rol ASC
      `,
      [ROLES_EXCLUIDOS]
    );

    return res.json({
      ok: true,
      roles: resultado.rows,
    });
  } catch (error) {
    console.error('Error al listar roles:', error);

    return res.status(500).json({
      ok: false,
      mensaje: 'Error interno al listar roles',
    });
  }
};

export const listarUsuarios = async (req, res) => {
  try {
    const {
      buscar = '',
      activos,
    } = req.query;

    let query = `
      SELECT
        u.id_usuario,
        u.nombre,
        u.usuario,
        u.correo,
        u.id_rol,
        r.nombre AS rol,
        u.activo,
        u.fecha_creacion,
        u.fecha_actualizacion,
        COALESCE(
          json_agg(
            DISTINCT jsonb_build_object(
              'id_sucursal', s.id_sucursal,
              'nombre', s.nombre,
              'clave', s.clave
            )
          ) FILTER (
            WHERE s.id_sucursal IS NOT NULL
          ),
          '[]'::json
        ) AS sucursales
      FROM usuarios u
      INNER JOIN roles r
        ON r.id_rol = u.id_rol
      LEFT JOIN usuario_sucursales us
        ON us.id_usuario = u.id_usuario
        AND us.activo = true
      LEFT JOIN sucursales s
        ON s.id_sucursal = us.id_sucursal
      WHERE UPPER(r.nombre) <> ALL($1::text[])
    `;

    const params = [ROLES_EXCLUIDOS];

    const textoBusqueda = String(buscar || '').trim();

    if (textoBusqueda) {
      params.push(`%${textoBusqueda}%`);

      query += `
        AND (
          u.nombre ILIKE $${params.length}
          OR u.usuario ILIKE $${params.length}
          OR COALESCE(u.correo, '') ILIKE $${params.length}
          OR r.nombre ILIKE $${params.length}
          OR COALESCE(s.nombre, '') ILIKE $${params.length}
        )
      `;
    }

    if (
      String(activos).toLowerCase() === 'true' ||
      String(activos) === '1'
    ) {
      query += `
        AND u.activo = true
      `;
    }

    if (
      String(activos).toLowerCase() === 'false' ||
      String(activos) === '0'
    ) {
      query += `
        AND u.activo = false
      `;
    }

    query += `
      GROUP BY
        u.id_usuario,
        u.nombre,
        u.usuario,
        u.correo,
        u.id_rol,
        r.nombre,
        u.activo,
        u.fecha_creacion,
        u.fecha_actualizacion
      ORDER BY u.nombre ASC
    `;

    const resultado = await pool.query(
      query,
      params
    );

    return res.json({
      ok: true,
      usuarios: resultado.rows,
    });
  } catch (error) {
    console.error('Error al listar usuarios:', error);

    return res.status(500).json({
      ok: false,
      mensaje: 'Error interno al listar usuarios',
    });
  }
};

export const crearUsuario = async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      nombre,
      usuario,
      correo,
      password,
      id_rol,
      sucursales,
      activo = true,
    } = req.body;

    const nombreNormalizado = String(nombre || '').trim();
    const usuarioNormalizado = String(usuario || '').trim();
    const correoNormalizado = String(correo || '').trim().toLowerCase();
    const idRol = normalizarId(id_rol);
    const sucursalesNormalizadas = normalizarSucursales(sucursales);
    const activoNormalizado = normalizarBooleano(activo, true);

    if (!nombreNormalizado) {
      return res.status(400).json({
        ok: false,
        mensaje: 'El nombre es obligatorio',
      });
    }

    if (!usuarioNormalizado) {
      return res.status(400).json({
        ok: false,
        mensaje: 'El usuario es obligatorio',
      });
    }

    if (!password || String(password).length < 6) {
      return res.status(400).json({
        ok: false,
        mensaje: 'La contraseña debe tener al menos 6 caracteres',
      });
    }

    if (!idRol) {
      return res.status(400).json({
        ok: false,
        mensaje: 'El rol es obligatorio',
      });
    }

    if (!sucursalesNormalizadas.length) {
      return res.status(400).json({
        ok: false,
        mensaje: 'Debes asignar al menos una sucursal',
      });
    }

    await client.query('BEGIN');

    const rolExiste = await client.query(
      `
        SELECT
          id_rol,
          nombre
        FROM roles
        WHERE id_rol = $1
          AND activo = true
          AND UPPER(nombre) <> ALL($2::text[])
        LIMIT 1
      `,
      [
        idRol,
        ROLES_EXCLUIDOS,
      ]
    );

    if (rolExiste.rows.length === 0) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        ok: false,
        mensaje: 'Rol no encontrado, inactivo o no permitido',
      });
    }

    const validacionSucursales = await validarSucursales(
      client,
      sucursalesNormalizadas
    );

    if (!validacionSucursales.ok) {
      await client.query('ROLLBACK');

      return res.status(400).json({
        ok: false,
        mensaje: validacionSucursales.mensaje,
      });
    }

    const existeUsuario = await client.query(
      `
        SELECT id_usuario
        FROM usuarios
        WHERE LOWER(usuario) = LOWER($1)
        LIMIT 1
      `,
      [usuarioNormalizado]
    );

    if (existeUsuario.rows.length > 0) {
      await client.query('ROLLBACK');

      return res.status(409).json({
        ok: false,
        mensaje: 'Ya existe un usuario con ese nombre de acceso',
      });
    }

    if (correoNormalizado) {
      const existeCorreo = await client.query(
        `
          SELECT id_usuario
          FROM usuarios
          WHERE LOWER(correo) = LOWER($1)
          LIMIT 1
        `,
        [correoNormalizado]
      );

      if (existeCorreo.rows.length > 0) {
        await client.query('ROLLBACK');

        return res.status(409).json({
          ok: false,
          mensaje: 'Ya existe un usuario con ese correo',
        });
      }
    }

    const passwordHash = await bcrypt.hash(
      String(password),
      10
    );

    const usuarioCreado = await client.query(
      `
        INSERT INTO usuarios (
          nombre,
          usuario,
          correo,
          password_hash,
          id_rol,
          activo
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6
        )
        RETURNING
          id_usuario,
          nombre,
          usuario,
          correo,
          id_rol,
          activo,
          fecha_creacion,
          fecha_actualizacion
      `,
      [
        nombreNormalizado,
        usuarioNormalizado,
        correoNormalizado || null,
        passwordHash,
        idRol,
        activoNormalizado,
      ]
    );

    const idUsuarioNuevo =
      usuarioCreado.rows[0].id_usuario;

    for (const idSucursal of sucursalesNormalizadas) {
      await client.query(
        `
          INSERT INTO usuario_sucursales (
            id_usuario,
            id_sucursal,
            activo
          )
          VALUES (
            $1,
            $2,
            true
          )
          ON CONFLICT (
            id_usuario,
            id_sucursal
          )
          DO UPDATE SET
            activo = true
        `,
        [
          idUsuarioNuevo,
          idSucursal,
        ]
      );
    }

    await client.query('COMMIT');

    return res.status(201).json({
      ok: true,
      mensaje: 'Usuario creado correctamente',
      usuario: {
        ...usuarioCreado.rows[0],
        rol: rolExiste.rows[0].nombre,
        sucursales: sucursalesNormalizadas,
      },
    });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {}

    console.error('Error al crear usuario:', error);

    if (error.code === '23505') {
      return res.status(409).json({
        ok: false,
        mensaje: 'Ya existe un usuario con esos datos',
      });
    }

    if (error.code === '23503') {
      return res.status(400).json({
        ok: false,
        mensaje: 'El rol o una de las sucursales seleccionadas no es válido',
      });
    }

    return res.status(500).json({
      ok: false,
      mensaje: 'Error interno al crear usuario',
    });
  } finally {
    client.release();
  }
};

export const actualizarUsuario = async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;

    const idUsuario = normalizarId(id);

    if (!idUsuario) {
      return res.status(400).json({
        ok: false,
        mensaje: 'El id del usuario no es válido',
      });
    }

    const {
      nombre,
      usuario,
      correo,
      password,
      id_rol,
      sucursales,
      activo,
    } = req.body;

    const nombreNormalizado = String(nombre || '').trim();
    const usuarioNormalizado = String(usuario || '').trim();
    const correoNormalizado = String(correo || '').trim().toLowerCase();
    const idRol = normalizarId(id_rol);
    const sucursalesNormalizadas = normalizarSucursales(sucursales);

    if (!nombreNormalizado) {
      return res.status(400).json({
        ok: false,
        mensaje: 'El nombre es obligatorio',
      });
    }

    if (!usuarioNormalizado) {
      return res.status(400).json({
        ok: false,
        mensaje: 'El usuario es obligatorio',
      });
    }

    if (!idRol) {
      return res.status(400).json({
        ok: false,
        mensaje: 'El rol es obligatorio',
      });
    }

    if (!sucursalesNormalizadas.length) {
      return res.status(400).json({
        ok: false,
        mensaje: 'Debes asignar al menos una sucursal',
      });
    }

    if (
      password &&
      String(password).trim() &&
      String(password).length < 6
    ) {
      return res.status(400).json({
        ok: false,
        mensaje: 'La nueva contraseña debe tener al menos 6 caracteres',
      });
    }

    await client.query('BEGIN');

    const usuarioActual = await client.query(
      `
        SELECT
          id_usuario,
          activo
        FROM usuarios
        WHERE id_usuario = $1
        FOR UPDATE
      `,
      [idUsuario]
    );

    if (usuarioActual.rows.length === 0) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        ok: false,
        mensaje: 'Usuario no encontrado',
      });
    }

    const rolExiste = await client.query(
      `
        SELECT
          id_rol,
          nombre
        FROM roles
        WHERE id_rol = $1
          AND activo = true
          AND UPPER(nombre) <> ALL($2::text[])
        LIMIT 1
      `,
      [
        idRol,
        ROLES_EXCLUIDOS,
      ]
    );

    if (rolExiste.rows.length === 0) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        ok: false,
        mensaje: 'Rol no encontrado, inactivo o no permitido',
      });
    }

    const validacionSucursales = await validarSucursales(
      client,
      sucursalesNormalizadas
    );

    if (!validacionSucursales.ok) {
      await client.query('ROLLBACK');

      return res.status(400).json({
        ok: false,
        mensaje: validacionSucursales.mensaje,
      });
    }

    const existeUsuario = await client.query(
      `
        SELECT id_usuario
        FROM usuarios
        WHERE LOWER(usuario) = LOWER($1)
          AND id_usuario <> $2
        LIMIT 1
      `,
      [
        usuarioNormalizado,
        idUsuario,
      ]
    );

    if (existeUsuario.rows.length > 0) {
      await client.query('ROLLBACK');

      return res.status(409).json({
        ok: false,
        mensaje: 'Ya existe otro usuario con ese nombre de acceso',
      });
    }

    if (correoNormalizado) {
      const existeCorreo = await client.query(
        `
          SELECT id_usuario
          FROM usuarios
          WHERE LOWER(correo) = LOWER($1)
            AND id_usuario <> $2
          LIMIT 1
        `,
        [
          correoNormalizado,
          idUsuario,
        ]
      );

      if (existeCorreo.rows.length > 0) {
        await client.query('ROLLBACK');

        return res.status(409).json({
          ok: false,
          mensaje: 'Ya existe otro usuario con ese correo',
        });
      }
    }

    const parametros = [
      nombreNormalizado,
      usuarioNormalizado,
      correoNormalizado || null,
      idRol,
      activo === undefined
        ? null
        : normalizarBooleano(
            activo,
            usuarioActual.rows[0].activo
          ),
    ];

    let query = `
      UPDATE usuarios
      SET
        nombre = $1,
        usuario = $2,
        correo = $3,
        id_rol = $4,
        activo = COALESCE($5, activo),
        fecha_actualizacion = CURRENT_TIMESTAMP
    `;

    if (
      password &&
      String(password).trim()
    ) {
      const passwordHash = await bcrypt.hash(
        String(password),
        10
      );

      parametros.push(passwordHash);

      query += `
        , password_hash = $${parametros.length}
      `;
    }

    parametros.push(idUsuario);

    query += `
      WHERE id_usuario = $${parametros.length}
      RETURNING
        id_usuario,
        nombre,
        usuario,
        correo,
        id_rol,
        activo,
        fecha_creacion,
        fecha_actualizacion
    `;

    const usuarioActualizado = await client.query(
      query,
      parametros
    );

    await client.query(
      `
        UPDATE usuario_sucursales
        SET activo = false
        WHERE id_usuario = $1
      `,
      [idUsuario]
    );

    for (const idSucursal of sucursalesNormalizadas) {
      await client.query(
        `
          INSERT INTO usuario_sucursales (
            id_usuario,
            id_sucursal,
            activo
          )
          VALUES (
            $1,
            $2,
            true
          )
          ON CONFLICT (
            id_usuario,
            id_sucursal
          )
          DO UPDATE SET
            activo = true
        `,
        [
          idUsuario,
          idSucursal,
        ]
      );
    }

    await client.query('COMMIT');

    return res.json({
      ok: true,
      mensaje: 'Usuario actualizado correctamente',
      usuario: {
        ...usuarioActualizado.rows[0],
        rol: rolExiste.rows[0].nombre,
        sucursales: sucursalesNormalizadas,
      },
    });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {}

    console.error('Error al actualizar usuario:', error);

    if (error.code === '23505') {
      return res.status(409).json({
        ok: false,
        mensaje: 'Ya existe otro usuario con esos datos',
      });
    }

    if (error.code === '23503') {
      return res.status(400).json({
        ok: false,
        mensaje: 'El rol o una de las sucursales seleccionadas no es válido',
      });
    }

    return res.status(500).json({
      ok: false,
      mensaje: 'Error interno al actualizar usuario',
    });
  } finally {
    client.release();
  }
};

export const desactivarUsuario = async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;

    const idUsuario = normalizarId(id);

    if (!idUsuario) {
      return res.status(400).json({
        ok: false,
        mensaje: 'El id del usuario no es válido',
      });
    }

    if (
      Number(idUsuario) ===
      Number(req.usuario?.id_usuario)
    ) {
      return res.status(400).json({
        ok: false,
        mensaje: 'No puedes desactivar tu propio usuario',
      });
    }

    await client.query('BEGIN');

    const resultado = await client.query(
      `
        UPDATE usuarios
        SET
          activo = false,
          fecha_actualizacion = CURRENT_TIMESTAMP
        WHERE id_usuario = $1
        RETURNING
          id_usuario,
          nombre,
          usuario,
          activo
      `,
      [idUsuario]
    );

    if (resultado.rows.length === 0) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        ok: false,
        mensaje: 'Usuario no encontrado',
      });
    }

    await client.query(
      `
        UPDATE usuario_sucursales
        SET activo = false
        WHERE id_usuario = $1
      `,
      [idUsuario]
    );

    await client.query('COMMIT');

    return res.json({
      ok: true,
      mensaje: 'Usuario desactivado correctamente',
      usuario: resultado.rows[0],
    });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {}

    console.error('Error al desactivar usuario:', error);

    return res.status(500).json({
      ok: false,
      mensaje: 'Error interno al desactivar usuario',
    });
  } finally {
    client.release();
  }
};
