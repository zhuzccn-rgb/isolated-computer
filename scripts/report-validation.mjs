export function reportHasFailures(data) {
  return Boolean(data.fatal || data.summary?.FAIL || data.cases?.some(c => c.status === 'FAIL'));
}
