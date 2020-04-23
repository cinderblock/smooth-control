export function validateNumber(name: string, num: number, max: number): void;
export function validateNumber(name: string, num: number, min: number, max: number): void;
export function validateNumber(name: string, num: number, min: number, negative: true): void;
export function validateNumber(name: string, num: number, min: number, max: number | true = 0): void {
  if (max === true) max = -min;

  if (max < min) {
    const temp = min;
    min = max;
    max = temp;
  }

  if (num === undefined) throw new Error(`'${name}' missing!`);
  if (typeof num !== 'number') throw new Error(`Incorrect type for '${name}'`);
  if (Number.isNaN(num)) throw new Error(`'${name}' is NaN`);
  if (num < min) throw new RangeError(`Incorrect value for '${name}'. ${num} is less than ${min}.`);
  if (num >= max) throw new RangeError(`Incorrect value for '${name}'. ${num} is equal to or greater than ${max}.`);
}
