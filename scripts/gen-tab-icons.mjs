/**
 * 탭바 아이콘 생성기 — raising-client `shared/ui/icon`의 SVG를 PNG(@1x/2x/3x)로 래스터화.
 * react-native-bottom-tabs는 아이템 아이콘을 이미지로 받으므로 웹과 동일한 모양을 PNG로 굽는다.
 * 활성 #292929 / 비활성 #CFCFCF, 흰 디테일 유지(풀컬러 — 템플릿 틴트 아님).
 *   실행: node scripts/gen-tab-icons.mjs
 */
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'tabs');
mkdirSync(OUT, { recursive: true });

const ACTIVE = '#292929';
const INACTIVE = '#CFCFCF';

const svgFor = (name, color) => {
  switch (name) {
    case 'home':
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 26 26"><path fill-rule="evenodd" clip-rule="evenodd" d="M3.44365 9.20947C3.16641 9.39509 3 9.70677 3 10.0404V21.8112C3 22.3635 3.44772 22.8112 4 22.8112H10C10.5523 22.8112 11 22.3635 11 21.8112V18.1165C11 17.5642 11.4477 17.1165 12 17.1165H14C14.5523 17.1165 15 17.5642 15 18.1165V21.8112C15 22.3635 15.4477 22.8112 16 22.8112H22C22.5523 22.8112 23 22.3635 23 21.8112V10.0404C23 9.70677 22.8336 9.39509 22.5563 9.20947L13.5563 3.1837C13.2197 2.9583 12.7803 2.9583 12.4437 3.1837L3.44365 9.20947Z" fill="${color}"/></svg>`;
    case 'map':
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 26 27"><path d="M21 9.48675C20.8633 14.0615 15.5695 19.8858 13.6699 21.8327C13.2981 22.2136 12.7025 22.214 12.3305 21.8333C10.4068 19.8643 5 13.9346 5 9.48675C5 4.89081 8.58172 1.5 13 1.5C17.4183 1.5 21 4.89081 21 9.48675Z" fill="${color}"/><circle cx="13" cy="9.5" r="3" fill="white"/></svg>`;
    case 'community':
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 26 26"><path fill-rule="evenodd" clip-rule="evenodd" d="M13.2029 1.5C18.7335 1.50001 23.2166 5.83331 23.2166 11.1787C23.2166 16.3595 19.0053 20.5891 13.7107 20.8447C13.6761 20.8522 13.6401 20.8584 13.6023 20.8584H2.50077C2.04115 20.8584 1.82532 20.2899 2.16874 19.9844L5.33671 17.165C3.99278 15.5176 3.18925 13.4394 3.18925 11.1787C3.18927 5.8333 7.67238 1.5 13.2029 1.5Z" fill="${color}"/><rect x="8" y="8.5" width="11" height="1" rx="0.5" fill="white"/><rect x="8" y="12.5" width="7" height="1" rx="0.5" fill="white"/></svg>`;
    case 'user':
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 26 26"><circle cx="13" cy="6" r="4" fill="${color}"/><path fill-rule="evenodd" clip-rule="evenodd" d="M3.12837 20.9179C2.94365 22.0069 3.85704 22.9093 4.96161 22.9093H21.0254C22.13 22.9093 23.0434 22.0069 22.8586 20.9179C21.998 15.8438 17.9085 12 12.9935 12C8.07849 12 3.98903 15.8438 3.12837 20.9179Z" fill="${color}"/></svg>`;
    default:
      throw new Error(`unknown icon ${name}`);
  }
};

const scales = [['', 26], ['@2x', 52], ['@3x', 78]];

for (const name of ['home', 'map', 'community', 'user']) {
  for (const [state, color] of [['active', ACTIVE], ['inactive', INACTIVE]]) {
    const svg = svgFor(name, color);
    for (const [suffix, px] of scales) {
      const density = Math.ceil(72 * (px / 26));
      const file = join(OUT, `${name}_${state}${suffix}.png`);
      await sharp(Buffer.from(svg), { density })
        .resize(px, px, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toFile(file);
    }
  }
}
console.log('tab icons generated →', OUT);
