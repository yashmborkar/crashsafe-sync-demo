import { CheckpointInvalidError } from '@yashborkar/crashsafe-sync';

const givenNames = ['Maya', 'Jordan', 'Avery', 'Rowan', 'Riley', 'Morgan', 'Quinn'];
const familyNames = ['Chen', 'Ramirez', 'Patel', 'Wilson', 'Okafor'];
const companies = ['Northstar Studio', 'Juniper Labs', 'Fieldwork Co.', 'Orbit Works', 'Common Thread'];
export const PAGE_SIZE = 10;
export const TOTAL_CUSTOMERS = givenNames.length * familyNames.length;
export const TOTAL_PAGES = Math.ceil(TOTAL_CUSTOMERS / PAGE_SIZE);

const customers = Array.from({ length: TOTAL_CUSTOMERS }, (_, index) => {
  const given = givenNames[index % givenNames.length];
  const family = familyNames[Math.floor(index / givenNames.length)];
  return {
    id: `CUS-${String(index + 1).padStart(3, '0')}`,
    name: `${given} ${family}`,
    email: `${given.toLowerCase()}.${family.toLowerCase()}@example.com`,
    company: companies[index % companies.length],
  };
});

export function getCustomerPage(checkpoint) {
  const offset = checkpoint === null ? 0 : checkpoint?.offset;
  if (!Number.isInteger(offset) || offset < 0 || offset >= TOTAL_CUSTOMERS || offset % PAGE_SIZE !== 0) {
    throw new CheckpointInvalidError('The simulated API received an invalid cursor.');
  }
  const records = customers.slice(offset, offset + PAGE_SIZE);
  const nextOffset = offset + records.length;
  const done = nextOffset === TOTAL_CUSTOMERS;
  return { records, nextCheckpoint: done ? null : { offset: nextOffset }, done };
}
