import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import {
  listarCatalogoAdmin,
  listarProductosParaCatalogo,
  crearProductoCatalogo,
  actualizarProductoCatalogo,
  cambiarEstadoProductoCatalogo,
  eliminarProductoCatalogo,
  listarRedesSocialesCatalogo,
  listarSucursalesWhatsappCatalogo,
  actualizarSucursalWhatsappCatalogo,
  actualizarRedSocialCatalogo,
} from '../controllers/catalogo.controller.js';
import { verificarToken } from '../middlewares/auth.middleware.js';

const router = Router();
const carpetaCatalogo = path.resolve('uploads/catalogo');

fs.mkdirSync(carpetaCatalogo, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, carpetaCatalogo),
  filename: (req, file, cb) => {
    const extension = path.extname(file.originalname || '').toLowerCase();
    const base = path
      .basename(file.originalname || 'imagen', extension)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'imagen';

    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${base}${extension}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 8 * 1024 * 1024,
    files: 8,
  },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype?.startsWith('image/')) {
      return cb(new Error('Solo se permiten archivos de imagen'));
    }
    return cb(null, true);
  },
});

const subirGaleria = upload.fields([
  { name: 'imagenes', maxCount: 8 },
  { name: 'imagen', maxCount: 1 },
]);

router.get('/productos-disponibles', verificarToken, listarProductosParaCatalogo);
router.get('/redes-sociales', verificarToken, listarRedesSocialesCatalogo);
router.put('/redes-sociales/:id', verificarToken, actualizarRedSocialCatalogo);
router.get('/sucursales-whatsapp', verificarToken, listarSucursalesWhatsappCatalogo);
router.put('/sucursales-whatsapp/:id', verificarToken, actualizarSucursalWhatsappCatalogo);
router.get('/', verificarToken, listarCatalogoAdmin);
router.post('/', verificarToken, subirGaleria, crearProductoCatalogo);
router.put('/:id', verificarToken, subirGaleria, actualizarProductoCatalogo);
router.patch('/:id/estado', verificarToken, cambiarEstadoProductoCatalogo);
router.delete('/:id', verificarToken, eliminarProductoCatalogo);

export default router;
