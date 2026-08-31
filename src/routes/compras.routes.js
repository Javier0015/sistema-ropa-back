import { Router } from 'express';

import {
  crearCompra,
  listarCompras,
  obtenerCompra,
  actualizarCompra,
  cancelarCompra,
  listarVariantesProductoCompra,
} from '../controllers/compras.controller.js';

import { verificarToken } from '../middlewares/auth.middleware.js';
import { uploadTicketProveedor } from '../middlewares/uploadTicketProveedor.middleware.js';

const router = Router();

// Debe estar antes de /:id para mantener las rutas específicas claras.
router.get(
  '/producto/:id_producto/variantes',
  verificarToken,
  listarVariantesProductoCompra
);

router.get('/', verificarToken, listarCompras);
router.get('/:id', verificarToken, obtenerCompra);

router.post(
  '/',
  verificarToken,
  uploadTicketProveedor.single('ticket'),
  crearCompra
);

router.put(
  '/:id',
  verificarToken,
  uploadTicketProveedor.single('ticket'),
  actualizarCompra
);

router.patch(
  '/:id/cancelar',
  verificarToken,
  cancelarCompra
);

export default router;
