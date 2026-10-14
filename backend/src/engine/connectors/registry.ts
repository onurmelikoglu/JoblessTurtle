import { ATS_CONNECTORS } from './ats-detect';
import { BOARD_CONNECTORS } from './boards';
import { careerPageConnector } from './career-page';
import { demoConnector } from './demo';
import { greenhouseConnector } from './greenhouse';
import { leverConnector } from './lever';
import { manualConnectors } from './manual';
import { Connector } from './types';

const ALL: Connector[] = [greenhouseConnector, leverConnector, ...ATS_CONNECTORS, careerPageConnector, demoConnector, ...BOARD_CONNECTORS, ...manualConnectors];

export const CONNECTORS = new Map(ALL.map((c) => [c.kind, c]));

export function connectorFor(kind: string): Connector {
  const c = CONNECTORS.get(kind);
  if (!c) throw new Error(`Bilinmeyen kaynak türü: ${kind}`);
  return c;
}

export function connectorCatalog() {
  return ALL.map((c) => ({
    kind: c.kind,
    label: c.label,
    accessMode: c.accessMode,
    capabilities: c.capabilities,
    defaultIntervalMinutes: c.defaultIntervalMinutes,
    minIntervalMinutes: c.minIntervalMinutes,
    applyChannel: c.applyChannel,
    isOfficial: c.isOfficial,
  }));
}
