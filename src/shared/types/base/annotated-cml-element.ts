export class AnnotatedCmlElement {
  #properties: Record<string, string | number | boolean> = {};

  public get properties(): Record<string, string | number | boolean> {
    return this.#properties;
  }

  public setProperties(properties: { [k: string]: string | number | boolean }): void {
    Object.assign(this.#properties, properties);
  }

  public hasProperties(): boolean {
    return Object.entries(this.properties).length > 0;
  }

  public generateAnnotation(): string {
    if (!this.hasProperties()) {
      return ''; // Return an empty string if no properties are set
    }

    const entries = Object.entries(this.properties);

    const formattedEntries = entries.map(([key, value]) => {
      const formattedValue = typeof value === 'string' ? `"${value}"` : value;
      return `${key} = ${formattedValue}`;
    });

    return `@(${formattedEntries.join(', ')})`;
  }
}
