//! Pure judgment adapters. No network calls; caller hints can only tighten.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Verdict { Pass, Escalate, Deny }
impl Verdict {
    pub fn as_str(self) -> &'static str {
        match self { Self::Pass => "pass", Self::Escalate => "escalate", Self::Deny => "deny" }
    }
    pub fn tighten(self, other: Self) -> Self { std::cmp::max(self, other) }
    // Unknown strings are consistently treated as no opinion.
    pub fn hint(value: Option<&str>) -> Self {
        match value { Some("deny") => Self::Deny, Some("escalate") => Self::Escalate, _ => Self::Pass }
    }
}
#[derive(Clone, Debug)]
pub struct JudgeInput {
    pub serial: u64,
    pub action: String,
    pub target: String,
    pub amount: u128,
    pub instruction_hash: String,
    pub source: String,
}
pub trait Judge { fn judge(&self, input: &JudgeInput) -> Verdict; }
#[derive(Clone, Debug)]
pub struct DefaultJudge {
    pub amount_threshold: u128,
    pub new_payee_check: bool,
    pub trusted_sources: Vec<String>,
    pub known_payees: Vec<String>,
    pub denied_targets: Vec<String>,
}
impl Judge for DefaultJudge {
    fn judge(&self, input: &JudgeInput) -> Verdict {
        if self.denied_targets.contains(&input.target) { return Verdict::Deny; }
        if input.amount > self.amount_threshold
            || (self.new_payee_check && !self.known_payees.contains(&input.target))
            || (!self.trusted_sources.is_empty() && !self.trusted_sources.contains(&input.source)) {
            Verdict::Escalate
        } else { Verdict::Pass }
    }
}
pub struct MockLlmJudge { pub verdict: Verdict }
impl Judge for MockLlmJudge {
    fn judge(&self, _input: &JudgeInput) -> Verdict { self.verdict }
}
/// Tier 1 is an absolute boundary, regardless of any adapter opinion.
pub fn final_decision(tier1_passed: bool, tier2: Verdict) -> Verdict {
    if tier1_passed { tier2 } else { Verdict::Deny }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> JudgeInput { JudgeInput { serial:1, action:"transfer".into(), target:"payee.test".into(), amount:10, instruction_hash:"hash".into(), source:"owner_chat".into() } }
    fn judge() -> DefaultJudge { DefaultJudge { amount_threshold:u128::MAX, new_payee_check:false, trusted_sources:vec![], known_payees:vec![], denied_targets:vec![] } }
    #[test]
    fn default_rules_and_precedence() {
        let i=input(); let mut j=judge(); assert_eq!(j.judge(&i),Verdict::Pass);
        j.amount_threshold=10; assert_eq!(j.judge(&i),Verdict::Pass);
        j.amount_threshold=9; assert_eq!(j.judge(&i),Verdict::Escalate);
        j.amount_threshold=u128::MAX; j.new_payee_check=true;
        assert_eq!(j.judge(&i),Verdict::Escalate); j.known_payees.push(i.target.clone());
        assert_eq!(j.judge(&i),Verdict::Pass); j.trusted_sources.push("other".into());
        assert_eq!(j.judge(&i),Verdict::Escalate); j.denied_targets.push(i.target.clone());
        assert_eq!(j.judge(&i),Verdict::Deny);
    }
    #[test]
    fn strictest_never_loosens() {
        for a in [Verdict::Pass,Verdict::Escalate,Verdict::Deny] {
            for b in [Verdict::Pass,Verdict::Escalate,Verdict::Deny] { assert!(a.tighten(b)>=a); }
        }
        assert_eq!(Verdict::Escalate.tighten(Verdict::Pass),Verdict::Escalate);
    }
    #[test]
    fn tier2_cannot_override_tier1_deny_any_hint() {
        for hint in [None,Some("pass"),Some("escalate"),Some("deny"),Some("invalid")] {
            for default in [Verdict::Pass,Verdict::Escalate,Verdict::Deny] {
                assert_eq!(final_decision(false,default.tighten(Verdict::hint(hint))),Verdict::Deny);
            }
        }
    }
    #[test]
    fn tier2_cannot_override_tier1_deny_mock_pass() {
        let mock=MockLlmJudge { verdict:Verdict::Pass };
        assert_eq!(final_decision(false,mock.judge(&input())),Verdict::Deny);
    }
    #[test]
    fn mock_only_tightens() {
        for v in [Verdict::Pass,Verdict::Escalate,Verdict::Deny] {
            let mock=MockLlmJudge { verdict:v };
            assert_eq!(Verdict::Pass.tighten(mock.judge(&input())),v);
            assert!(Verdict::Escalate.tighten(mock.judge(&input()))>=Verdict::Escalate);
            assert_eq!(final_decision(true,v),v);
            assert_eq!(v.tighten(MockLlmJudge { verdict:Verdict::Pass }.judge(&input())),v);
        }
    }
}
