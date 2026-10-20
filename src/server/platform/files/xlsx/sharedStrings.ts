// xl/sharedStrings.xml: <si> = конкатенация всех <t>, фонетика <rPh> пропускается (дизайн C4d §3.4).
import { SpreadsheetError } from '../types';
import { parseXml } from './xml';

export function parseSharedStrings(xml: Uint8Array, maxCount: number): string[] {
  const out: string[] = [];
  let cur: string | null = null;
  let inT = false;
  let phonetic = 0;
  parseXml(xml, {
    open(local) {
      if (local === 'si') cur = '';
      else if (local === 'rPh') phonetic++;
      else if (local === 't' && cur !== null && phonetic === 0) inT = true;
    },
    text(t) {
      if (inT && cur !== null) cur += t;
    },
    close(local) {
      if (local === 't') inT = false;
      else if (local === 'rPh') phonetic--;
      else if (local === 'si' && cur !== null) {
        out.push(cur);
        cur = null;
        if (out.length > maxCount) throw new SpreadsheetError('zip_limits');
      }
    },
  });
  return out;
}
