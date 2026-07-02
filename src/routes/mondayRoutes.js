const express = require('express');
const router = express.Router();
const {
  getClientDashboard,
  assignBoardToClient,
  getClients,
  updateStatus,
  getItemUpdates,
  createClientItemUpdate,
  submitItemApproval,
  getAdminBoard,
  getClientPermissions,
  updateClientPermissions,
  getAdminPortalSettings,
  syncAdminSubscription,
  saveAdminPortalSettings,
  getAdminActivity,
  getAdminFileRequests,
  createClientFileRequest,
  submitClientFileRequest,
  createClient,
  updateClient,
  createInviteForClient,
  deleteClient,
} = require('../controllers/mondayController');
const { authenticate } = require('../middleware/authMiddleware');
const { authenticateAdmin, requireAdminWrite } = require('../middleware/adminMiddleware');
const { handleMondayWebhook } = require('../controllers/webhookController');

// Client-facing routes (require client JWT)
router.get('/dashboard', authenticate, getClientDashboard);
router.post('/status-update', authenticate, updateStatus);
router.get('/items/:itemId/updates', authenticate, getItemUpdates);
router.post('/items/:itemId/updates', authenticate, createClientItemUpdate);
router.post('/items/:itemId/approval', authenticate, submitItemApproval);
router.post('/file-requests/:id/submit', authenticate, submitClientFileRequest);
router.post('/webhooks', handleMondayWebhook);

// Admin routes (require admin authentication)
router.get('/clients', authenticateAdmin, getClients);
router.get('/admin/settings', authenticateAdmin, getAdminPortalSettings);
router.post('/admin/subscription/sync', authenticateAdmin, syncAdminSubscription);
router.put('/admin/settings', authenticateAdmin, requireAdminWrite, saveAdminPortalSettings);
router.get('/admin/activity', authenticateAdmin, getAdminActivity);
router.get('/admin/file-requests', authenticateAdmin, getAdminFileRequests);
router.post('/admin/assign', authenticateAdmin, requireAdminWrite, assignBoardToClient);
router.get('/admin/boards/:boardId', authenticateAdmin, getAdminBoard);
router.get('/clients/:id/permissions', authenticateAdmin, getClientPermissions);
router.put('/clients/:id/permissions', authenticateAdmin, requireAdminWrite, updateClientPermissions);
router.post('/clients', authenticateAdmin, requireAdminWrite, createClient);
router.post('/clients/:id/invite', authenticateAdmin, requireAdminWrite, createInviteForClient);
router.post('/clients/:id/file-requests', authenticateAdmin, requireAdminWrite, createClientFileRequest);
router.put('/clients/:id', authenticateAdmin, requireAdminWrite, updateClient);
router.delete('/clients/:id', authenticateAdmin, requireAdminWrite, deleteClient);

module.exports = router;
