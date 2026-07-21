export async function retry(operation, options = {}) {
  const { maxAttempts = 3, shouldRetry = () => true } = options;
  let lastError;
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error)) break;
    }
  }
  return lastError;
}
