import { SEED_COMPANIES, SEED_LOCAL, SEED_PEOPLE } from './seed-data.js';
import type {
  CompanyFilters,
  CompanyMatch,
  LeadProvider,
  LocalFilters,
  LocalMatch,
  PeopleFilters,
  PersonEnrichRef,
  PersonEnrichment,
  PersonMatch,
} from './types.js';

const incl = (hay: string, needle: string) => hay.toLowerCase().includes(needle.toLowerCase());
const anyIncl = (hay: string, needles: string[]) => needles.some((n) => incl(hay, n));

/** In-memory provider over the seed fixture. Drop-in replaceable by Apollo/PDL. */
export function createSeedProvider(): LeadProvider {
  return {
    name: 'seed',
    metered: false, // the in-memory fixture never hits a paid API → never quota-limited or debited

    async searchPeople(f: PeopleFilters): Promise<PersonMatch[]> {
      return SEED_PEOPLE.filter((p) => {
        if (f.seniorities && !f.seniorities.includes(p.seniority)) return false;
        if (f.departments && !f.departments.includes(p.department)) return false;
        if (
          f.companyIndustries &&
          (!p.companyIndustry || !f.companyIndustries.includes(p.companyIndustry))
        ) {
          return false;
        }
        if (f.companySize && p.companySize !== f.companySize) return false;
        if (f.locations && !anyIncl(`${p.location ?? ''} ${p.country ?? ''}`, f.locations)) {
          return false;
        }
        if (f.titleKeywords && !anyIncl(p.title, f.titleKeywords)) return false;
        if (f.keywords && !anyIncl(`${p.fullName} ${p.title} ${p.companyName ?? ''}`, f.keywords)) {
          return false;
        }
        return true;
      }).slice(0, f.limit);
    },

    async searchCompanies(f: CompanyFilters): Promise<CompanyMatch[]> {
      return SEED_COMPANIES.filter((c) => {
        if (f.industries && !f.industries.includes(c.industry)) return false;
        if (f.size && c.sizeBand !== f.size) return false;
        if (f.locations && !anyIncl(`${c.location ?? ''} ${c.country ?? ''}`, f.locations)) {
          return false;
        }
        if (f.nameKeywords && !anyIncl(c.name, f.nameKeywords)) return false;
        if (f.keywords && !anyIncl(`${c.name} ${c.industry}`, f.keywords)) return false;
        return true;
      }).slice(0, f.limit);
    },

    async searchLocal(f: LocalFilters): Promise<LocalMatch[]> {
      return SEED_LOCAL.filter((b) => {
        if (f.category && !f.category.includes(b.category)) return false;
        if (f.locations && !anyIncl(`${b.city ?? ''} ${b.country ?? ''}`, f.locations)) {
          return false;
        }
        if (f.nameKeywords && !anyIncl(b.name, f.nameKeywords)) return false;
        return true;
      }).slice(0, f.limit);
    },

    // Enrichment over the fixture: ONLY for leads this provider produced (seed:* ids) — a foreign
    // lead (e.g. saved from Apollo, then LEAD_PROVIDER switched back to seed) gets an honest null,
    // never a fabricated @example.com address on a real person. Free (metered=false), deterministic.
    async enrichPerson(ref: PersonEnrichRef): Promise<PersonEnrichment | null> {
      if (!ref.externalId?.startsWith('seed:')) return null;
      const p = SEED_PEOPLE.find((x) => x.externalId === ref.externalId);
      return p?.email ? { email: p.email, title: p.title, linkedinUrl: p.linkedinUrl } : null;
    },
  };
}
