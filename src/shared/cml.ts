import { ConfiguratorRuleInput } from './models.js';

export function generateCMLFromGroup(group: ConfiguratorRuleInput[]): string {
  const output: string[] = [];

  for (const rule of group) {
    output.push(`rule "${rule.apiName}"`);
    output.push('when');
    output.push('  // TODO: Insert conditions from criteria');
    output.push('then');
    output.push('  // TODO: Insert actions');
    output.push('end\n');
  }

  return output.join('\n');
}
