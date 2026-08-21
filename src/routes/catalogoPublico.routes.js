import { Router } from 'express';
import {
  listarCatalogoPublico,
  obtenerDetalleProductoPublico,
  listarCategoriasCatalogoPublico,
} from '../controllers/catalogoPublico.controller.js';
import {
  listarRedesSocialesPublicas,
  listarSucursalesWhatsappPublicas,
} from '../controllers/catalogo.controller.js';

const router = Router();

router.get('/categorias', listarCategoriasCatalogoPublico);
router.get('/redes-sociales', listarRedesSocialesPublicas);
router.get('/sucursales-whatsapp', listarSucursalesWhatsappPublicas);
router.get('/', listarCatalogoPublico);
router.get('/:id', obtenerDetalleProductoPublico);

export default router;
