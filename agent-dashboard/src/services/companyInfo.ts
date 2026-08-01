export interface CompanyInfo {
    legalName: string;
    street: string;
    postalCode: string;
    city: string;
    country: string;
    managingDirector: string;
    registerCourt: string;
    registerNumber: string;
    vatNotice: string;
    supportEmail: string;
    emailFrom: string;
    supportPhone: string;
    contentResponsibleName: string;
    contentResponsibleAddress: string;
}

function configured(name: string, fallback: string): string {
    return process.env[name]?.trim() || fallback;
}

export function getCompanyInfo(): CompanyInfo {
    return {
        legalName: configured('COMPANY_LEGAL_NAME', 'NaturVitale UG (haftungsbeschraenkt)'),
        street: configured('COMPANY_STREET', 'Brahmsstr. 72'),
        postalCode: configured('COMPANY_POSTAL_CODE', '27474'),
        city: configured('COMPANY_CITY', 'Cuxhaven'),
        country: configured('COMPANY_COUNTRY', 'Deutschland'),
        managingDirector: configured('COMPANY_MANAGING_DIRECTOR', 'Sawsan Safi'),
        registerCourt: configured('COMPANY_REGISTER_COURT', 'Amtsgericht Bremen'),
        registerNumber: configured('COMPANY_REGISTER_NUMBER', 'HRB 40637 HB'),
        vatNotice: configured('COMPANY_VAT_NOTICE', 'Es wird zurzeit keine Umsatzsteuer ausgewiesen (wird mit dem Finanzamt geklaert).'),
        supportEmail: configured('SUPPORT_EMAIL', 'kontakt@natur-vitale.de'),
        emailFrom: configured('EMAIL_FROM', 'kontakt@natur-vitale.de'),
        supportPhone: configured('SUPPORT_PHONE', '+49 176 68526814'),
        contentResponsibleName: configured('CONTENT_RESPONSIBLE_NAME', 'Sawsan Safi'),
        contentResponsibleAddress: configured('CONTENT_RESPONSIBLE_ADDRESS', 'Brahmsstr. 72, 27474 Cuxhaven'),
    };
}