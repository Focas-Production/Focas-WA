import { describe, expect, it } from 'vitest';
import { renderTemplateBody } from './template-render';

describe('renderTemplateBody', () => {
  it('fills positional placeholders', () => {
    expect(renderTemplateBody('Hi {{1}}, order {{2}}.', ['John', 'A1'])).toBe(
      'Hi John, order A1.',
    );
  });
  it('fills named placeholders by canonical key order', () => {
    // keys sort to [name, order_id]
    expect(
      renderTemplateBody('Order {{order_id}} for {{name}}.', ['John', 'A1']),
    ).toBe('Order A1 for John.');
  });
  it('leaves missing values visible', () => {
    expect(renderTemplateBody('Hi {{name}}!', [])).toBe('Hi {{name}}!');
  });
});
