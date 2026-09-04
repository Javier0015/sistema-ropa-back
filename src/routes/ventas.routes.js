import { Router } from 'express';

import {
  crearVenta,
  listarVentas,
  obtenerVenta,
  obtenerInfoDevolucionVenta,
  devolverVenta,
  listarVentasServiciosClinicos,
  cancelarServicioClinicoPendiente,
} from '../controllers/ventas.controller.js';

import {
  buscarVentaParaCambio,
  listarVentasParaCambioPorFecha,
  crearCambioDevolucion,
  listarCambiosDevoluciones,
} from '../controllers/devoluciones.controller.js';

import { verificarToken } from '../middlewares/auth.middleware.js';

const router = Router();

/*
 * Rutas fijas primero.
 */
router.get(
  '/servicios-clinicos',
  verificarToken,
  listarVentasServiciosClinicos
);

router.patch(
  '/servicios-clinicos/:idSolicitud/cancelar-pendiente',
  verificarToken,
  cancelarServicioClinicoPendiente
);

/*
 * Nuevo módulo: Cambios / Devoluciones.
 *
 * IMPORTANTE:
 * Estas rutas deben ir antes de /:id para que Express no interprete
 * "cambios" como si fuera un id de venta.
 */
router.get(
  '/cambios/ventas-dia',
  verificarToken,
  listarVentasParaCambioPorFecha
);

router.get(
  '/cambios/buscar-venta',
  verificarToken,
  buscarVentaParaCambio
);

router.get(
  '/cambios/historial',
  verificarToken,
  listarCambiosDevoluciones
);

router.post(
  '/cambios',
  verificarToken,
  crearCambioDevolucion
);

/*
 * Venta nueva.
 */
router.post('/', verificarToken, crearVenta);

/*
 * Rutas dinámicas después de las rutas fijas.
 */
router.get(
  '/:id/devolucion-info',
  verificarToken,
  obtenerInfoDevolucionVenta
);

router.post(
  '/:id/devolver',
  verificarToken,
  devolverVenta
);

router.get('/:id', verificarToken, obtenerVenta);

/*
 * Listado general.
 */
router.get('/', verificarToken, listarVentas);

export default router;
