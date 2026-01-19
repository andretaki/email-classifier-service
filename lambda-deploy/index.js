// Lambda handler wrapper for email-classifier-service
// This file properly exports handlers for AWS Lambda

const mainCode = require('./lambda-simple-flags.js');

// Main email processor handler (for EmailProcessorFunction and ScheduledProcessorFunction)
exports.handler = mainCode.handler;

// Health check handler (for HealthCheckFunction)
exports.healthHandler = mainCode.healthHandler;

// Stats handler (for StatsApiFunction)
exports.statsHandler = mainCode.statsHandler;

// For backwards compatibility - some functions might call these directly
exports.processEmail = exports.handler;
exports.getStats = exports.statsHandler;
exports.healthCheck = exports.healthHandler;