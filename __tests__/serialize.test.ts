import { expect, describe, test } from 'vitest';
import {
  BinaryFileServiceSchema,
  FallibleServiceSchema,
  TestServiceSchema,
} from './fixtures/services';
import { serializeSchema } from '../router';
import { Type } from '@sinclair/typebox';

describe('serialize server to jsonschema', () => {
  test('serialize entire service schema', () => {
    const schema = { test: TestServiceSchema };
    const handshakeSchema = Type.Object({
      token: Type.String(),
    });

    expect(serializeSchema(schema, handshakeSchema)).toMatchSnapshot();
  });
});

describe('serialize service to jsonschema', () => {
  test('serialize basic service', () => {
    expect(TestServiceSchema.serialize()).toMatchSnapshot();
  });

  test('serialize service with binary', () => {
    expect(BinaryFileServiceSchema.serialize()).toMatchSnapshot();
  });

  test('serialize service with errors', () => {
    expect(FallibleServiceSchema.serialize()).toMatchSnapshot();
  });

  test('serialize backwards compatible with v1', () => {
    expect(TestServiceSchema.serializeV1Compat()).toMatchSnapshot();
  });
});
