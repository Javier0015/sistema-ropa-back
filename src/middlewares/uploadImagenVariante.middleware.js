import fs from 'fs';
import path from 'path';
import multer from 'multer';

const carpetaVariantes = path.resolve(
  process.cwd(),
  'uploads',
  'variantes'
);

fs.mkdirSync(carpetaVariantes, { recursive: true });

const extensionesPermitidas = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, carpetaVariantes);
  },
  filename: (req, file, cb) => {
    const idVariante = Number(req.params?.idVariante || 0);
    const extension = extensionesPermitidas[file.mimetype] || '.jpg';
    const aleatorio = Math.floor(Math.random() * 1_000_000_000);

    cb(
      null,
      `variante-${idVariante || 'sin-id'}-${Date.now()}-${aleatorio}${extension}`
    );
  },
});

const fileFilter = (req, file, cb) => {
  if (!extensionesPermitidas[file.mimetype]) {
    const error = new Error(
      'Formato de imagen no permitido. Usa JPG, PNG o WEBP.'
    );
    error.statusCode = 400;
    return cb(error);
  }

  return cb(null, true);
};

export const uploadImagenVariante = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 12 * 1024 * 1024,
  },
});
