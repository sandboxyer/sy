/**
 * Converts an object's properties into an array of { key, value } objects
 * with extensive filtering and configuration options.
 * 
 * @param {Object} obj - The input object to convert
 * @param {Object} [config={}] - Configuration options
 * @param {string[]} [config.blacklistKeys=[]] - Array of key names to exclude
 * @param {string[]} [config.whitelistKeys=[]] - Array of key names to include (if set, only these keys are included)
 * @param {string[]} [config.ignoreTypes=[]] - Array of types to exclude ('function', 'object', 'array', 'undefined', 'null', 'symbol', 'bigint')
 * @param {boolean} [config.deep=false] - Whether to recursively convert nested objects
 * @param {boolean} [config.ignoreFunctions=true] - Whether to ignore function values (convenience flag)
 * @param {boolean} [config.ignoreUndefined=true] - Whether to ignore undefined values (convenience flag)
 * @param {string} [config.keyName='key'] - Custom name for the key property
 * @param {string} [config.valueName='value'] - Custom name for the value property
 * @param {Function} [config.filterFn=null] - Custom filter function (receives key, value, returns boolean)
 * @param {Function} [config.transformFn=null] - Custom transform function (receives key, value, returns transformed value)
 * @returns {Array<Object>} Array of key-value pair objects
 * 
 * @throws {TypeError} If input is not a plain object
 */
function objToArray(obj, config = {}) {
    // Destructure config with defaults
    const {
      blacklistKeys = [],
      whitelistKeys = null,
      ignoreTypes = [],
      deep = false,
      ignoreFunctions = true,
      ignoreUndefined = true,
      keyName = 'key',
      valueName = 'value',
      filterFn = null,
      transformFn = null
    } = config;
  
    // Validate input
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new TypeError('Input must be a plain object');
    }
  
    // Build complete type ignore list
    const typesToIgnore = new Set(ignoreTypes.map(t => t.toLowerCase()));
    
    // Add convenience flags
    if (ignoreFunctions) typesToIgnore.add('function');
    if (ignoreUndefined) typesToIgnore.add('undefined');
  
    /**
     * Internal helper to check if a value should be ignored based on its type
     */
    function shouldIgnoreByType(value) {
      if (value === null) return typesToIgnore.has('null');
      if (Array.isArray(value)) return typesToIgnore.has('array');
      return typesToIgnore.has(typeof value);
    }
  
    /**
     * Internal helper to process a single key-value pair
     */
    function processEntry(key, value) {
      // Check whitelist (if whitelist is set, only include keys in whitelist)
      if (whitelistKeys !== null && !whitelistKeys.includes(key)) {
        return null;
      }
  
      // Check blacklist
      if (blacklistKeys.includes(key)) {
        return null;
      }
  
      // Check type ignore
      if (shouldIgnoreByType(value)) {
        return null;
      }
  
      // Apply custom filter function
      if (filterFn && !filterFn(key, value)) {
        return null;
      }
  
      // Apply custom transform function
      let processedValue = value;
      if (transformFn) {
        processedValue = transformFn(key, value);
      }
  
      // Handle nested objects if deep is enabled
      if (deep && 
          processedValue !== null && 
          typeof processedValue === 'object' && 
          !Array.isArray(processedValue)) {
        processedValue = objectToKeyValueArray(processedValue, config);
      }
  
      return {
        [keyName]: key,
        [valueName]: processedValue
      };
    }
  
    // Process all entries
    const result = [];
    const entries = Object.entries(obj);
    
    for (const [key, value] of entries) {
      const processed = processEntry(key, value);
      if (processed !== null) {
        result.push(processed);
      }
    }
  
    return result;
  }

  export default objToArray