import { Router } from 'express';

import {
  listarInventarioPorSucursal,
  listarBajoStock,
  asignarInventario,
  ajustarInventario,
  listarMovimientosInventario,
  listarLotesProducto,
  actualizarLote,
  listarCaducidadProxima,
  bajaLotePorCaducidad,
  consultarStockSucursales,
  actualizarImagenReferenciaVariante,
} from '../controllers/inventario.controller.js';

import { verificarToken } from '../middlewares/auth.middleware.js';
import { uploadImagenVariante } from '../middlewares/uploadImagenVariante.middleware.js';

const router = Router();

/*
 * Rutas específicas primero.
 */
router.get(
  '/bajo-stock',
  verificarToken,
  listarBajoStock
);

router.get(
  '/movimientos',
  verificarToken,
  listarMovimientosInventario
);

router.get(
  '/lotes',
  verificarToken,
  listarLotesProducto
);

router.get(
  '/caducidad-proxima',
  verificarToken,
  listarCaducidadProxima
);

router.get(
  '/stock-sucursales',
  verificarToken,
  consultarStockSucursales
);

router.post(
  '/asignar',
  verificarToken,
  asignarInventario
);

router.post(
  '/ajustar',
  verificarToken,
  ajustarInventario
);

router.post(
  '/baja-caducidad',
  verificarToken,
  bajaLotePorCaducidad
);

/*
 * Imagen opcional de referencia de una variante.
 * La imagen queda en producto_variantes y después viaja al POS
 * dentro de inventario[].variantes[].imagen_referencia.
 */
router.post(
  '/variantes/:idVariante/imagen',
  verificarToken,
  uploadImagenVariante.single('imagen'),
  actualizarImagenReferenciaVariante
);

router.put(
  '/lotes/:id_lote',
  verificarToken,
  actualizarLote
);

/*
 * Listado general al final.
 */
router.get(
  '/',
  verificarToken,
  listarInventarioPorSucursal
);

export default router;
