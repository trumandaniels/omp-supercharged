export function mergeRanges(ranges) {
  if (ranges.length === 0) return [];
  const sorted = ranges.sort((left, right) => left[0] - right[0]);
  const merged = [sorted[0]];
  for (const [start, end] of sorted.slice(1)) {
    const previous = merged[merged.length - 1];
    if (start <= previous[1] + 1) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  return merged;
}
