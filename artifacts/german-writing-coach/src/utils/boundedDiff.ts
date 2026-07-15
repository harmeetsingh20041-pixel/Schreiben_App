export const DIFF_SEQUENCE_OPERATION_BUDGET = 1_000_000;

export function sequenceDiffExceedsBudget(leftLength: number, rightLength: number) {
  const combinedLength = leftLength + rightLength;
  return combinedLength * combinedLength > DIFF_SEQUENCE_OPERATION_BUDGET;
}

export function sharedSequenceBounds<T>(left: T[], right: T[]) {
  const sharedLength = Math.min(left.length, right.length);
  let prefixLength = 0;
  while (
    prefixLength < sharedLength &&
    left[prefixLength] === right[prefixLength]
  ) {
    prefixLength += 1;
  }

  let leftEnd = left.length;
  let rightEnd = right.length;
  while (
    leftEnd > prefixLength &&
    rightEnd > prefixLength &&
    left[leftEnd - 1] === right[rightEnd - 1]
  ) {
    leftEnd -= 1;
    rightEnd -= 1;
  }

  return { prefixLength, leftEnd, rightEnd };
}
