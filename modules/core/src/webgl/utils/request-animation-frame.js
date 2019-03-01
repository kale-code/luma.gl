// Node.js polyfills for requestAnimationFrame and cancelAnimationFrame
/* global window, setTimeout, clearTimeout */

export function requestAnimationFrame(callback, device = window) {
  return typeof device !== 'undefined' && device.requestAnimationFrame
    ? device.requestAnimationFrame(callback)
    : setTimeout(callback, 1000 / 60);
}

export function cancelAnimationFrame(timerId, device = window) {
  return typeof device !== 'undefined' && device.cancelAnimationFrame
    ? device.cancelAnimationFrame(timerId)
    : clearTimeout(timerId);
}
