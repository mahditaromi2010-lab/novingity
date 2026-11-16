'use strict';
// Permissions-Policy: the site uses no camera, microphone, location, USB or the Payment Request API,
// so the browser is told to refuse them even if injected script asks.
const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), usb=(), payment=(), interest-cohort=()';

module.exports = { PERMISSIONS_POLICY };
