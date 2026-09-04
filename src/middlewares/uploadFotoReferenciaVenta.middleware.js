import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';

const DIRECTORIO_FOTOS_VENTAS = path.join(
  process.cwd(),
  'uploads',
  'ventas-referencias'
);

fs.mkdirSync(DIRECTORIO_FOTOS_VENTAS, { recursive: true });

const EXTENSION_POR_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, DIRECTORIO_FOTOS_VENTAS);
  },
  filename: (_req, file, cb) => {
    const extension =
      EXTENSION_POR_MIME[file.mimetype] ||
      path.extname(file.originalname || '').toLowerCase() ||
      '.jpg';

    const aleatorio = crypto.randomBytes(6).toString('hex');
    cb(null, `venta-${Date.now()}-${aleatorio}${extension}`);
  },
});

const uploadFoto = multer({
  storage,
  limits: {
    fileSize: 8 * 1024 * 1024,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    const tiposPermitidos = ['image/jpeg', 'image/png', 'image/webp'];

    if (!tiposPermitidos.includes(file.mimetype)) {
      const error = new Error(
        'Formato no permitido. La foto debe ser JPG, PNG o WEBP.'
      );
      error.codigoFoto = 'FORMATO_NO_PERMITIDO';
      return cb(error);
    }

    return cb(null, true);
  },
});

/**
 * Middleware con respuesta JSON controlada para que los errores de Multer no
 * terminen en la página genérica de error del backend.
 */
export const procesarFotoReferenciaVenta = (req, res, next) => {
  uploadFoto.single('foto')(req, res, (error) => {
    if (!error) return next();

    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          ok: false,
          mensaje: 'La fotografía supera el límite de 8 MB.',
        });
      }

      return res.status(400).json({
        ok: false,
        mensaje: `No se pudo recibir la fotografía: ${error.message}`,
      });
    }

    return res.status(400).json({
      ok: false,
      mensaje: error.message || 'La fotografía enviada no es válida.',
    });
  });
};
