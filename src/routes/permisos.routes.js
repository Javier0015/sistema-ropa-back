import express from 'express';

import {
  obtenerPermisos,
  obtenerModulos,
  obtenerPermisosPorRol,
  obtenerConfiguracionPorRol,
  actualizarPermisosRol,
} from '../controllers/permisos.controller.js';

const router = express.Router();

/*
|--------------------------------------------------------------------------
| PERMISOS
|--------------------------------------------------------------------------
|
| GET /api/permisos
|
| Regresa todos los permisos agrupados por rol.
|
*/
router.get('/', obtenerPermisos);


/*
|--------------------------------------------------------------------------
| MÓDULOS
|--------------------------------------------------------------------------
|
| GET /api/permisos/modulos
|
| Regresa todos los módulos disponibles.
|
| IMPORTANTE:
| Esta ruta debe estar antes de /:rol para que Express no interprete
| "modulos" como si fuera un nombre de rol.
|
*/
router.get('/modulos', obtenerModulos);


/*
|--------------------------------------------------------------------------
| CONFIGURACIÓN DE UN ROL
|--------------------------------------------------------------------------
|
| GET /api/permisos/configuracion/CAJERO
|
| Regresa todos los módulos indicando true/false.
|
| Esta será la ruta principal para construir la pantalla de configuración.
|
*/
router.get(
  '/configuracion/:rol',
  obtenerConfiguracionPorRol
);


/*
|--------------------------------------------------------------------------
| PERMISOS DE UN ROL
|--------------------------------------------------------------------------
|
| GET /api/permisos/CAJERO
|
*/
router.get('/:rol', obtenerPermisosPorRol);


/*
|--------------------------------------------------------------------------
| ACTUALIZAR PERMISOS
|--------------------------------------------------------------------------
|
| PUT /api/permisos/CAJERO
|
| Body:
|
| {
|   "permisos": [
|      "pos",
|      "caja",
|      "ventas"
|   ]
| }
|
*/
router.put('/:rol', actualizarPermisosRol);


export default router;