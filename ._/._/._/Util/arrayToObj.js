/**
 * Converts an array of { key, value } objects back into a plain object
 * with extensive filtering and configuration options.
 * 
 * @param {Array<Object>} arr - The input array to convert back to object
 * @param {Object} [config={}] - Configuration options
 * @param {string[]} [config.blacklistKeys=[]] - Array of key names to exclude
 * @param {string[]} [config.whitelistKeys=[]] - Array of key names to include (if set, only these keys are included)
 * @param {string[]} [config.ignoreTypes=[]] - Array of types to exclude ('function', 'object', 'array', 'undefined', 'null', 'symbol', 'bigint')
 * @param {boolean} [config.deep=false] - Whether to recursively convert nested key-value arrays back to objects
 * @param {boolean} [config.ignoreFunctions=true] - Whether to ignore function values (convenience flag)
 * @param {boolean} [config.ignoreUndefined=true] - Whether to ignore undefined values (convenience flag)
 * @param {string} [config.keyName='key'] - Custom name for the key property in the array objects
 * @param {string} [config.valueName='value'] - Custom name for the value property in the array objects
 * @param {Function} [config.filterFn=null] - Custom filter function (receives key, value, returns boolean)
 * @param {Function} [config.transformFn=null] - Custom transform function (receives key, value, returns transformed value)
 * @returns {Object} Plain object reconstructed from the array
 * 
 * @throws {TypeError} If input is not an array
 */
function arrayToObj(arr, config = {}) {
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
    if (!Array.isArray(arr)) {
      throw new TypeError('Input must be an array');
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
  
      // Handle nested arrays if deep is enabled
      if (deep && 
          Array.isArray(processedValue) && 
          processedValue.length > 0 && 
          processedValue[0] && 
          typeof processedValue[0] === 'object' && 
          !Array.isArray(processedValue[0]) &&
          keyName in processedValue[0] && 
          valueName in processedValue[0]) {
        processedValue = arrayToObj(processedValue, config);
      }
  
      return processedValue;
    }
  
    // Process all entries
    const result = {};
    
    for (const item of arr) {
      // Validate each array item has the required key and value properties
      if (!item || typeof item !== 'object' || !(keyName in item) || !(valueName in item)) {
        continue; // Skip invalid entries
      }
      
      const key = item[keyName];
      const value = item[valueName];
      const processedValue = processEntry(key, value);
      
      if (processedValue !== null) {
        result[key] = processedValue;
      }
    }
  
    return result;
  }

  export default arrayToObj;