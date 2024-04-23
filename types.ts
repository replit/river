import {
  ArrayOptions,
  NumberOptions,
  ObjectOptions,
  SchemaOptions,
  StringOptions,
  TArray,
  TBoolean,
  TLiteral,
  TLiteralValue,
  TNumber,
  TObject,
  TProperties,
  TSchema,
  TString,
  TUint8Array,
  TUnion,
  Type as TypeboxType,
  Uint8ArrayOptions,
} from '@sinclair/typebox';

export interface RiverSchema extends TSchema {
  description: string;
}

interface RiverSchemaOptions extends SchemaOptions {
  description: string;
}

export interface RiverArray<T extends RiverSchema = RiverSchema>
  extends TArray<T> {
  description: string;
}

interface RiverArrayOptions extends ArrayOptions {
  description: string;
}

function Array(schema: RiverSchema, options: RiverArrayOptions): RiverArray {
  return {
    ...TypeboxType.Array(schema, options),
    description: options.description,
  };
}

export interface RiverBoolean extends TBoolean {
  description: string;
}

function Boolean(options: RiverSchemaOptions): RiverBoolean {
  return {
    ...TypeboxType.Boolean(options),
    description: options.description,
  };
}

export interface RiverLiteral<T extends TLiteralValue> extends TLiteral<T> {
  description: string;
}

function Literal<T extends TLiteralValue>(
  value: T,
  options: RiverSchemaOptions,
): RiverLiteral<T> {
  return {
    ...TypeboxType.Literal(value, options),
    description: options.description,
  };
}

interface RiverNumberOptions extends NumberOptions {
  description: string;
}

export interface RiverNumber extends TNumber {
  description: string;
}

function Number(options: RiverNumberOptions): RiverNumber {
  return {
    ...TypeboxType.Number(options),
    description: options.description,
  };
}

interface RiverObjectOptions extends ObjectOptions {
  description: string;
}

export interface RiverObject<T extends TProperties = TProperties>
  extends TObject<T> {
  description: string;
}

interface RiverProperties extends TProperties {
  [x: string]: RiverSchema | TUnion<Array<RiverSchema>>;
  [x: number]: RiverSchema | TUnion<Array<RiverSchema>>;
}

function Object<T extends RiverProperties>(
  properties: T,
  options: RiverObjectOptions,
): RiverObject<T> {
  return {
    ...TypeboxType.Object(properties, options),
    description: options.description,
  };
}

interface RiverStringOptions extends StringOptions {
  description: string;
}

export interface RiverString extends TString {
  description: string;
}

function String(options: RiverStringOptions): RiverString {
  return {
    ...TypeboxType.String(options),
    description: options.description,
  };
}

interface RiverUint8ArrayOptions extends Uint8ArrayOptions {
  description: string;
}

export interface RiverUint8Array extends TUint8Array {
  description: string;
}

function Uint8Array(options: RiverUint8ArrayOptions): RiverUint8Array {
  return {
    ...TypeboxType.Uint8Array(options),
    description: options.description,
  };
}

function Union<T extends Array<RiverSchema>>(
  schemas: [...T],
  options?: RiverSchemaOptions,
) {
  return TypeboxType.Union(schemas, options);
}

export const Type = {
  Array,
  Boolean,
  Literal,
  Number,
  Object,
  Optional: TypeboxType.Optional,
  String,
  Uint8Array,
  Union,
};
