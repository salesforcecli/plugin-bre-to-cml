import { findInMap, isSameIds } from '../../utils/common.utils.js';
import { CmlAttribute } from '../cml-attribute.js';
import { AnnotatedCmlElement } from './types.js';

export class AnnotatedCmlElementWAttributes extends AnnotatedCmlElement {
  #attributes: Map<string, CmlAttribute> = new Map();

  public get attributes(): CmlAttribute[] {
    return Array.from(this.#attributes.values());
  }

  public getAttribute(name: string): CmlAttribute | undefined {
    return findInMap(this.#attributes, 'name', name);
  }

  public findAttributeById(attributeId: string): CmlAttribute | null {
    return Array.from(this.#attributes.values()).find((a) => isSameIds(a.attributeId, attributeId)) ?? null;
  }

  public addAttribute(a: CmlAttribute): void {
    this.#attributes.set(a.name, a);
  }

  public hasAttributes(): boolean {
    return this.attributes.length > 0;
  }
}
