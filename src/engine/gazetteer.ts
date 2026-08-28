/**
 * Small, hand-curated word lists used by the lightweight local entity
 * recogniser. Deliberately compact: this ships as plain text in the bundle,
 * needs no model download, and runs in well under a millisecond.
 */

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean))

/** Common given names across the regions Veeam teams typically work with. */
export const FIRST_NAMES = words(`
james john robert michael william david richard joseph thomas charles
christopher daniel matthew anthony mark donald steven paul andrew joshua
kenneth kevin brian george timothy ronald edward jason jeffrey ryan jacob
gary nicholas eric jonathan stephen larry justin scott brandon benjamin
samuel gregory alexander patrick frank raymond jack dennis jerry tyler aaron
jose adam nathan henry douglas zachary peter kyle ethan walter noah jeremy
christian keith roger terry gerald harold sean austin carl arthur lawrence
dylan jesse jordan bryan billy joe bruce gabriel logan albert willie alan
juan wayne elijah randy roy vincent ralph eugene russell bobby mason philip
louis liam oliver lucas mateo levi asher leo julian owen theodore
mary patricia jennifer linda elizabeth barbara susan jessica sarah karen
nancy lisa margaret betty sandra ashley dorothy kimberly emily donna michelle
carol amanda melissa deborah stephanie rebecca laura sharon cynthia kathleen
amy shirley angela helen anna brenda pamela nicole samantha katherine emma
ruth christine catherine debra rachel carolyn janet virginia maria heather
diane julie joyce victoria kelly christina joan evelyn lauren judith olivia
frances martha cheryl megan andrea hannah jacqueline ann jean alice kathryn
gloria teresa doris sara janice julia marie madison grace judy theresa beverly
denise marilyn amber danielle abigail brittany rose natalie sophia isabella
charlotte mia amelia harper evelyn ella scarlett chloe zoe lily aria
thabo sipho lerato nomsa mandla bongani thandiwe zanele kagiso lindiwe
sibusiso nkosi themba refilwe tshepo naledi ayanda mpho karabo palesa
lungile busisiwe sizwe vusi phumzile dineo katlego lehlohonolo boitumelo
pieter johan hendrik willem jaco riaan francois dirk andre stefan marius
gerhard hannes danie kobus christo werner louwrens anneke elmarie marlize
susanna hester johanna magdalena annemarie carike ilse marike liezel
priya rahul amit anjali arjun deepak divya kiran manish neha pooja rajesh
ravi sanjay shreya sunil vikram anita ashok gaurah meera nikhil rohit
wei ming li chen jing yan hui feng xiao lin ping hao jun mei
ivan dmitri sergei natalia olga anastasia mikhail alexei elena tatiana
ahmed mohamed fatima aisha omar yusuf hassan ali khalid layla noor zainab
carlos luis miguel jorge ricardo fernando javier alejandro diego pablo
sofia valentina camila lucia elena isabel carmen rosa
hans klaus jurgen wolfgang dieter stefan matthias andreas thomas
pierre jacques michel philippe olivier laurent nicolas sylvie celine
marco luca giuseppe antonio francesco alessandro giulia francesca chiara
lars erik sven bjorn magnus anders henrik niels johan mikael
`)

/** Frequent surnames — used to raise confidence on a two-token name. */
export const SURNAMES = words(`
smith johnson williams brown jones garcia miller davis rodriguez martinez
hernandez lopez gonzalez wilson anderson thomas taylor moore jackson martin
lee perez thompson white harris sanchez clark ramirez lewis robinson walker
young allen king wright scott torres nguyen hill flores green adams nelson
baker hall rivera campbell mitchell carter roberts gomez phillips evans
turner diaz parker cruz edwards collins reyes stewart morris morales murphy
cook rogers gutierrez ortiz morgan cooper peterson bailey reed kelly howard
ramos kim cox ward richardson watson brooks chavez wood james bennett gray
mendoza ruiz hughes price alvarez castillo sanders patel myers long ross
foster jimenez powell jenkins perry russell sullivan bell coleman butler
henderson barnes fisher vasquez simmons romero jordan patterson alexander
hamilton graham reynolds griffin wallace moreno west cole hayes bryant
herrera gibson ellis tran medina aguilar stevens murray ford castro marshall
owens harrison fernandez mcdonald woods washington kennedy wells vargas
henry chen freeman webb tucker guzman burns crawford olson simpson porter
hunter gordon mendez silva shaw snyder mason dixon munoz hunt hicks holmes
palmer wagner black robertson boyd rose stone salazar fox warren mills
meyer rice schmidt garza daniels ferguson nichols stephens soto weaver ryan
gardner payne grant dunn kelley spencer hawkins arnold pierce vazquez hansen
peters santos hart bradley knight elliott cunningham duncan armstrong hudson
carroll lane riley andrews ruiz harper fowler burke larson hoffman
botha van niekerk pretorius nel venter kruger fourie steyn coetzee jordaan
naidoo pillay govender moodley reddy singh kumar sharma gupta mehta shah
dlamini nkosi ndlovu khumalo mabaso mokoena molefe sithole zulu mahlangu
tshabalala maseko mnguni ngcobo mthembu radebe motaung zwane mashaba
mueller schmidt schneider fischer weber wagner becker hoffmann schulz koch
rossi russo ferrari esposito bianchi romano colombo ricci marino greco
dubois bernard thomas petit durand leroy moreau simon laurent michel
ivanov petrov sokolov popov kuznetsov novak horvath kowalski nowak wojcik
tanaka suzuki sato watanabe yamamoto nakamura kobayashi wang zhang liu yang
huang zhao wu zhou xu sun ma zhu hu guo lin he gao
oconnor obrien murphy kelly walsh byrne doyle mcCarthy gallagher doherty
`)

/** Cities and countries — kept short on purpose; low severity anyway. */
export const PLACES = words(`
johannesburg pretoria durban capetown bloemfontein sandton midrand centurion
soweto polokwane nelspruit kimberley rustenburg stellenbosch pietermaritzburg
london manchester birmingham liverpool leeds glasgow edinburgh dublin belfast
paris lyon marseille berlin munich hamburg frankfurt cologne stuttgart
amsterdam rotterdam utrecht brussels antwerp madrid barcelona valencia lisbon
rome milan naples turin vienna zurich geneva prague warsaw budapest bucharest
stockholm oslo copenhagen helsinki dubai riyadh doha cairo nairobi lagos accra
mumbai delhi bangalore chennai hyderabad pune kolkata karachi lahore dhaka
singapore tokyo osaka seoul beijing shanghai shenzhen guangzhou hongkong
sydney melbourne brisbane perth auckland wellington toronto vancouver montreal
newyork chicago boston seattle austin dallas houston atlanta denver phoenix
miami philadelphia washington baltimore detroit minneapolis portland
saopaulo riodejaneiro buenosaires santiago bogota lima mexicocity
`)

/**
 * Suffixes distinctive enough to mark a company even without a cue word, e.g.
 * a spreadsheet cell that just says "ACME Holdings". Deliberately excludes the
 * ambiguous short forms (SA, AG, NV, BV) which are also ordinary abbreviations.
 */
export const STANDALONE_ORG_SUFFIXES = words(`
ltd limited inc llc plc gmbh sarl corp corporation holdings group bank
insurance solutions technologies systems industries enterprises consulting
logistics healthcare motors foods
`)

/** Trading-name suffixes that make a company name unambiguous. */
export const ORG_SUFFIXES = [
  'Pty Ltd',
  'Pty. Ltd.',
  '(Pty) Ltd',
  'Ltd',
  'Ltd.',
  'Limited',
  'Inc',
  'Inc.',
  'LLC',
  'L.L.C.',
  'PLC',
  'plc',
  'GmbH',
  'AG',
  'NV',
  'N.V.',
  'BV',
  'B.V.',
  'SA',
  'SARL',
  'Corp',
  'Corp.',
  'Corporation',
  'Holdings',
  'Group',
  'Bank',
  'Insurance',
  'Solutions',
  'Technologies',
  'Systems',
  'Industries',
  'Enterprises',
  'Consulting',
  'Logistics',
  'Healthcare',
  'Retail',
  'Mining',
  'Motors',
  'Foods',
]

/**
 * Acronyms that look like a company but are just technical vocabulary.
 * Anything here is never flagged as an organisation.
 */
export const TECH_ACRONYMS = words(`
SQL VPN HTTP HTTPS FTP SFTP SSH RDP DNS DHCP LDAP SMTP IMAP POP3 API REST
SOAP JSON XML CSV PDF ZIP RAM CPU GPU SSD HDD NAS SAN RAID LUN VM VMS ESX
ESXI HYPERV KVM AWS GCP AZURE S3 EC2 IAM VPC CDN SLA SLO ETA ASAP FYI EOD
COB TBD TBC OK KPI ROI CEO CTO CIO CFO COO HR IT OPS DEV QA UAT PROD STG
DR BCP RPO RTO GDPR POPIA HIPAA PCI SOC ISO NIST MFA SSO OTP TLS SSL CA
CRM ERP SAP EDI B2B B2C SME SMB MSP VAR OEM NDA PO SOW RFP RFI RFQ
US USA UK EU EMEA APAC LATAM NA SA AI ML LLM NLP OCR UI UX QA CI CD
VBR VBO VCC VAW VSPC NBD ETL BI ID URL URI UUID GUID PII PHI PCI
AM PM GMT UTC CET EST PST SAST MB GB TB PB KB MS NS
UNIX AIX SOLARIS HPUX SNMP NFS SMB CIFS ISCSI FC WWN VSS CBT NTFS ZFS XFS
EXT4 BTRFS RHEL SUSE UBUNTU DEBIAN CENTOS CLI GUI YAML TOML NVME SATA SAS
VBM VONE VB365 M365 O365 ENTRA SAML OAUTH OIDC KMS HSM TPM UEFI BIOS JBOD
`)

/** Words that start sentences and would otherwise look like a name. */
export const SENTENCE_STARTERS = words(`
the a an and but or if when while this that these those there here it its
please can could would should will shall may might must do does did have
has had is are was were be been being we our us you your i my me they them
their he she his her hi hello dear thanks thank regards kind best good
morning afternoon evening today tomorrow yesterday also however therefore
after before during since until because although unless whether what which
who whom whose why how where all any some most many few each every no not
attached following below above see note nb ps
`)

/** Infrastructure tokens that mark a string as an internal hostname. */
export const INFRA_TOKENS = words(`
SQL DB DBS MSSQL ORACLE MYSQL PG POSTGRES MONGO REDIS
SRV SVR SERVER HOST NODE VM VMS CLU CLUSTER
DC AD ADDS LDAP DNS DHCP CA PKI
APP APPS WEB IIS NGINX APACHE API GW GATEWAY PRX PROXY LB
FS FILE NAS SAN STOR STORAGE REPO REPOS BKP BACKUP ARCH ARCHIVE TAPE
EXCH EXCHANGE MAIL SMTP MX SP SHAREPOINT
ESX ESXI VC VCSA VCENTER HV HYPERV XEN KVM
VBR VBO VCC VAW VSPC VEEAM PROXY WAN
CTX CITRIX RDS TS VDI
CRM ERP SAP BI ETL
PROD PRD DEV DEVL TEST TST UAT QA STG STAGE STAGING DR PREPROD SANDBOX
CORP HQ BRANCH SITE EDGE CORE DMZ LAN WAN
`)

export function isFirstName(token: string): boolean {
  return FIRST_NAMES.has(token.toLowerCase())
}

export function isSurname(token: string): boolean {
  return SURNAMES.has(token.toLowerCase())
}

export function isPlace(token: string): boolean {
  return PLACES.has(token.toLowerCase().replace(/\s+/g, ''))
}

export function isOrgSuffixWord(token: string): boolean {
  return STANDALONE_ORG_SUFFIXES.has(token.toLowerCase().replace(/\.$/, ''))
}

export function isTechAcronym(token: string): boolean {
  return TECH_ACRONYMS.has(token.toUpperCase())
}

export function isSentenceStarter(token: string): boolean {
  return SENTENCE_STARTERS.has(token.toLowerCase())
}

export function hasInfraToken(hostname: string): boolean {
  return hostname
    .split(/[-_.]/)
    .some((part) => INFRA_TOKENS.has(part.replace(/\d+$/, '').toUpperCase()))
}
