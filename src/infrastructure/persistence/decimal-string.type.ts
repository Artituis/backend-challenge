import { Type } from '@mikro-orm/core';

/** SQL numeric remains a string all the way through the driver and mapper. */
export class DecimalStringType extends Type<string, string> {
  override convertToDatabaseValue(value: string): string { return this.validate(value); }
  override convertToJSValue(value: string): string { return this.validate(value); }
  override getColumnType(): string { return 'numeric'; }
  override compareAsType(): string { return 'string'; }

  private validate(value: string): string {
    if (typeof value !== 'string' || !/^-?(0|[1-9]\d{0,35})(\.\d{1,2})?$/.test(value)) {
      throw new RangeError('Persisted money requires a decimal string with at most 36 integer and 2 fractional digits');
    }
    return value;
  }
}
