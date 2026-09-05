//! Product-owned legacy BitFun domain adapters.
//!
//! The generic service crate owns offline orchestration and filesystem safety;
//! this module binds each legacy reader and converter to the current product
//! domain model without moving those owners into the service layer.

mod common;
mod extensions;
mod settings;

use openbitfun_legacy_migration::{
    DomainContext, DomainScan, LegacyDomainAdapter, LegacyMigrationResult, MigrationRoots,
};
use openbitfun_product_domains::legacy_migration::{
    FindingSeverity, MigrationDomainId, MigrationDomainResult, MigrationDomainState,
    MigrationSelection, ScanFinding,
};

pub fn adapters_for_groups(selection: &MigrationSelection) -> Vec<Box<dyn LegacyDomainAdapter>> {
    let selected = selection.expanded_domains();
    let mut adapters: Vec<Box<dyn LegacyDomainAdapter>> = Vec::new();
    if selected.contains(&MigrationDomainId::Settings) {
        adapters.push(Box::new(settings::SettingsAdapter));
    }
    if selected.contains(&MigrationDomainId::Credentials) {
        adapters.push(Box::new(settings::CredentialsAdapter));
    }
    if selected.contains(&MigrationDomainId::Skills) {
        adapters.push(Box::new(extensions::SkillsAdapter));
    }
    if selected.contains(&MigrationDomainId::Miniapps) {
        adapters.push(Box::new(extensions::MiniappsAdapter));
    }
    if selected.contains(&MigrationDomainId::Agents) {
        adapters.push(Box::new(extensions::AgentsAdapter));
    }
    if selected.contains(&MigrationDomainId::CrossReferenceRepair) {
        adapters.push(Box::new(CrossReferenceAdapter));
    }
    adapters
}

struct CrossReferenceAdapter;

impl LegacyDomainAdapter for CrossReferenceAdapter {
    fn domain(&self) -> MigrationDomainId {
        MigrationDomainId::CrossReferenceRepair
    }

    fn scan(&self, _roots: &MigrationRoots) -> LegacyMigrationResult<DomainScan> {
        Ok(DomainScan {
            finding: ScanFinding {
                domain: self.domain(),
                code: "cross_reference_validation_pending".to_string(),
                severity: FindingSeverity::Info,
                migratable: true,
                detail: "Selected owner adapters do not yet expose cross-domain references."
                    .to_string(),
                ..ScanFinding::default()
            },
            conflicts: Vec::new(),
            target_schema: Some("openbitfun.cross-references.current".to_string()),
            dependencies: Vec::new(),
        })
    }

    fn stage(&self, _context: &DomainContext<'_>) -> LegacyMigrationResult<MigrationDomainResult> {
        Ok(MigrationDomainResult {
            domain: self.domain(),
            state: MigrationDomainState::Staged,
            ..MigrationDomainResult::default()
        })
    }

    fn validate_stage(&self, _context: &DomainContext<'_>) -> LegacyMigrationResult<()> {
        Ok(())
    }

    fn commit(&self, _context: &DomainContext<'_>) -> LegacyMigrationResult<()> {
        Ok(())
    }

    fn validate_commit(&self, _context: &DomainContext<'_>) -> LegacyMigrationResult<()> {
        Ok(())
    }
}
