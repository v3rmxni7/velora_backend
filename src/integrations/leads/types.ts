// Provider contract for lead discovery. The SeedProvider implements this now;
// an Apollo/PDL adapter is a true drop-in later (same in/out shapes).

export type EntityType = 'person' | 'company' | 'local_business';

export type Seniority = 'c_level' | 'vp' | 'director' | 'manager' | 'senior' | 'mid' | 'entry';
export type Department =
  | 'engineering'
  | 'sales'
  | 'marketing'
  | 'product'
  | 'finance'
  | 'operations'
  | 'hr'
  | 'legal'
  | 'support'
  | 'other';
export type Industry =
  | 'saas'
  | 'fintech'
  | 'healthcare'
  | 'ecommerce'
  | 'manufacturing'
  | 'agency'
  | 'edtech'
  | 'biotech'
  | 'logistics'
  | 'real_estate';
export type SizeBand = '1-10' | '11-50' | '51-200' | '201-500' | '501-1000' | '1001-5000' | '5000+';
export type LocalCategory =
  | 'restaurant'
  | 'dentist'
  | 'gym'
  | 'salon'
  | 'law_firm'
  | 'cafe'
  | 'auto_repair'
  | 'real_estate_agency';

export interface PeopleFilters {
  titleKeywords?: string[];
  seniorities?: Seniority[];
  departments?: Department[];
  companyIndustries?: Industry[];
  companySize?: SizeBand;
  locations?: string[];
  keywords?: string[];
  limit: number;
}
export interface CompanyFilters {
  nameKeywords?: string[];
  industries?: Industry[];
  size?: SizeBand;
  locations?: string[];
  keywords?: string[];
  limit: number;
}
export interface LocalFilters {
  category?: LocalCategory[];
  nameKeywords?: string[];
  locations?: string[];
  limit: number;
}

export interface PersonMatch {
  externalId: string;
  firstName: string;
  lastName: string;
  fullName: string;
  email?: string;
  title: string;
  seniority: Seniority;
  department: Department;
  companyExternalId?: string;
  companyName?: string;
  companyIndustry?: Industry;
  companySize?: SizeBand;
  location?: string;
  country?: string;
  linkedinUrl?: string;
}
export interface CompanyMatch {
  externalId: string;
  name: string;
  domain?: string;
  industry: Industry;
  sizeBand: SizeBand;
  employeeCount?: number;
  location?: string;
  country?: string;
  linkedinUrl?: string;
}
export interface LocalMatch {
  externalId: string;
  name: string;
  category: LocalCategory;
  phone?: string;
  address?: string;
  city?: string;
  country?: string;
  website?: string;
  googleMapsUrl?: string;
  rating?: number;
}

export interface LeadProvider {
  readonly name: string;
  searchPeople(filters: PeopleFilters): Promise<PersonMatch[]>;
  searchCompanies(filters: CompanyFilters): Promise<CompanyMatch[]>;
  searchLocal(filters: LocalFilters): Promise<LocalMatch[]>;
}
