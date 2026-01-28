// ============================================================
// V35 UTILITIES
// ============================================================
// Shared utility functions for V35 modules.
// ============================================================

/**
 * Safely stringify objects that may contain circular references (e.g., Axios errors).
 * Returns a max-length string suitable for logging.
 */
export function safeStringify(obj: unknown, maxLength = 500): string {
  if (obj === null) return 'null';
  if (obj === undefined) return 'undefined';
  
  if (typeof obj === 'string') {
    return obj.slice(0, maxLength);
  }
  
  if (obj instanceof Error) {
    // Extract just the error message and a few safe properties
    const errInfo = {
      name: obj.name,
      message: obj.message?.slice(0, 200),
      code: (obj as any).code,
      status: (obj as any).status || (obj as any).response?.status,
    };
    return JSON.stringify(errInfo).slice(0, maxLength);
  }
  
  try {
    // Attempt normal stringify first
    return JSON.stringify(obj).slice(0, maxLength);
  } catch {
    // Handle circular references
    const seen = new WeakSet();
    try {
      const result = JSON.stringify(obj, (key, value) => {
        // Skip problematic properties that cause circular refs
        if (
          key === 'socket' ||
          key === '_httpMessage' ||
          key === 'parser' ||
          key === 'agent' ||
          key === 'request' ||
          key === 'response' ||
          key === 'config' ||
          key === 'connection'
        ) {
          return '[Circular]';
        }
        
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) {
            return '[Circular]';
          }
          seen.add(value);
        }
        return value;
      });
      return result.slice(0, maxLength);
    } catch {
      // Last resort: extract only safe primitive properties
      if (typeof obj === 'object' && obj !== null) {
        const safe: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) {
            safe[k] = typeof v === 'string' ? v.slice(0, 100) : v;
          }
        }
        return JSON.stringify(safe).slice(0, maxLength);
      }
      return String(obj).slice(0, maxLength);
    }
  }
}

/**
 * Extract a clean error message from any error type.
 * Safe for Axios, fetch, and other network errors.
 */
export function getErrorMessage(err: unknown): string {
  if (!err) return 'unknown_error';
  
  if (typeof err === 'string') {
    return err.slice(0, 200);
  }
  
  if (err instanceof Error) {
    const msg = err.message || err.name || 'Error';
    // Extract status code from Axios-like errors
    const status = (err as any).response?.status || (err as any).status || (err as any).code;
    if (status) {
      return `${msg.slice(0, 150)} (${status})`;
    }
    return msg.slice(0, 200);
  }
  
  if (typeof err === 'object' && err !== null) {
    const e = err as any;
    if (e.message) return String(e.message).slice(0, 200);
    if (e.error) return String(e.error).slice(0, 200);
    if (e.msg) return String(e.msg).slice(0, 200);
  }
  
  return String(err).slice(0, 200);
}
