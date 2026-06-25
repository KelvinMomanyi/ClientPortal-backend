const express = require('express');
const router = express.Router();
const {
  getClientDashboard,
  assignBoardToClient,
  getClients,
  updateStatus,
  getItemUpdates,
  createClientItemUpdate,
  getAdminBoard,
  getClientPermissions,
  updateClientPermissions,
  createClient,
  updateClient,
  createInviteForClient,
  deleteClient,
} = require('../controllers/mondayController');
const { authenticate } = require('../middleware/authMiddleware');
const { authenticateAdmin } = require('../middleware/adminMiddleware');
const { handleMondayWebhook } = require('../controllers/webhookController');

// Client-facing routes (require client JWT)
router.get('/dashboard', authenticate, getClientDashboard);
router.post('/status-update', authenticate, updateStatus);
router.get('/items/:itemId/updates', authenticate, getItemUpdates);
router.post('/items/:itemId/updates', authenticate, createClientItemUpdate);
router.post('/webhooks', handleMondayWebhook);

// Admin routes (require admin authentication)
router.get('/clients', authenticateAdmin, getClients);
router.post('/admin/assign', authenticateAdmin, assignBoardToClient);
router.get('/admin/boards/:boardId', authenticateAdmin, getAdminBoard);
router.get('/clients/:id/permissions', authenticateAdmin, getClientPermissions);
router.put('/clients/:id/permissions', authenticateAdmin, updateClientPermissions);
router.post('/clients', authenticateAdmin, createClient);
router.post('/clients/:id/invite', authenticateAdmin, createInviteForClient);
router.put('/clients/:id', authenticateAdmin, updateClient);
router.delete('/clients/:id', authenticateAdmin, deleteClient);

module.exports = router;
