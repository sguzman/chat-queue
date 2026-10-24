const test=require('node:test');
const assert=require('node:assert/strict');
require('../src/signal.js');
const rules=require('../src/rules.js');
const r=(id,phase,type='propose',priority=1)=>({version:1,id,enabled:true,priority,
  when:{phase},then:type==='pause'?{type}:{type,text:'Synthetic proposed response'}});
const e=(phase='finished',origin='fresh',epoch=1,sequence=7)=>({
  version:1,route:'/c/synthetic',documentToken:'a'.repeat(32),
  epoch,sequence,phase,origin,confidence:'inferred'});
test('rules normalize deterministic, bounded and typed declarative schema',()=>{
  const got=rules.normalize([r('lower','finished'),r('higher','finished','pause',90)]);
  assert.equal(got.ok,true);assert.deepEqual(got.rules.map(x=>x.id),['higher','lower']);
  assert.equal(Object.isFrozen(got.rules[0]),true);
  assert.equal(rules.normalize(new Array(33).fill(r('same','finished'))).error,'invalid-rule-count');
});
test('reject duplicate IDs, unknown executable fields and oversize proposal text',()=>{
  assert.equal(rules.normalize([r('x','finished'),r('x','failed')]).error,'invalid-rule');
  assert.equal(rules.normalize([{...r('x','finished'),eval:'alert(1)'}]).error,'invalid-rule');
  assert.equal(rules.normalize([r('x','finished','propose',-1)]).error,'invalid-rule');
  assert.equal(rules.normalize([{...r('x','finished'),then:{type:'propose',text:'X'.repeat(24001)}}]).error,'invalid-proposal-text');
  assert.equal(rules.normalize([{...r('x','finished','pause'),then:{type:'pause',text:'unexpected'}}]).error,'unexpected-pause-text');
});
test('highest priority matching rule wins and only returns a proposal',()=>{
  const got=rules.evaluate([r('later','finished'),r('pause','finished','pause',50)],e());
  assert.equal(got.ok,true);assert.equal(got.reason,'preview-only');
  assert.equal(got.decision.ruleId,'pause');assert.equal(got.decision.action.type,'pause');
  assert.equal(got.decision.approvalRequired,true);
});
test('duplicate event key is not considered twice; other phases remain distinct',()=>{
  const list=[r('ok','finished'),r('error','failed')];
  const first=rules.evaluate(list,e());
  assert.equal(rules.evaluate(list,e('finished','fresh',1,19),[first.decision.eventKey]).reason,'already-considered');
  assert.equal(rules.evaluate(list,e('failed'),[first.decision.eventKey]).decision.ruleId,'error');
});
test('historical and unconfirmed responses never produce proposals',()=>{
  assert.equal(rules.evaluate([r('ok','finished')],e('finished','restored')).reason,'not-actionable');
  assert.equal(rules.evaluate([r('ok','finished')],e('finished','fresh',0)).reason,'not-actionable');
  assert.equal(rules.evaluate([r('ok','finished')],{...e(),confidence:'unknown'}).reason,'not-actionable');
  assert.equal(rules.evaluate([r('ok','finished')],{...e(),sequence:0}).error,'invalid-event');
});
test('error, interruption and limit have independent declarative branches',()=>{
  const list=[r('error','failed'),r('disconnect','interrupted','pause'),r('limit','limit','pause')];
  assert.equal(rules.evaluate(list,e('failed')).decision.ruleId,'error');
  assert.equal(rules.evaluate(list,e('interrupted')).decision.ruleId,'disconnect');
  assert.equal(rules.evaluate(list,e('limit')).decision.ruleId,'limit');
});
test('confidence and disabled conditions are obeyed without code evaluation',()=>{
  const disabled={...r('disabled','finished','pause',100),enabled:false};
  const observed={...r('observed','finished','pause',50),when:{phase:'finished',confidence:'observed'}};
  const fallback=r('fallback','finished','propose',10);
  assert.equal(rules.evaluate([disabled,observed,fallback],e()).decision.ruleId,'fallback');
  assert.equal(rules.evaluate([disabled,observed,fallback],{...e(),confidence:'observed'}).decision.ruleId,'observed');
});
test('bounded replay history and malformed shape fail closed',()=>{
  assert.equal(rules.evaluate([],e(),new Array(257).fill('x')).error,'invalid-history');
  assert.equal(rules.evaluate([],null).error,'invalid-event');
  assert.equal(rules.evaluate([r('ok','finished')],e('generating')).reason,'not-actionable');
});
test('bounded duration predicates require explicit simulated state duration',()=>{
  const timed={...r('timed','interrupted','pause',50),when:{phase:'interrupted',minDurationMs:5000,maxDurationMs:8000}};
  const fallback=r('fallback','interrupted','propose',10);
  assert.equal(rules.evaluate([timed,fallback],e('interrupted')).decision.ruleId,'fallback');
  assert.equal(rules.evaluate([timed,fallback],e('interrupted'),[],{stateDurationMs:4999}).decision.ruleId,'fallback');
  assert.equal(rules.evaluate([timed,fallback],e('interrupted'),[],{stateDurationMs:5000}).decision.ruleId,'timed');
  assert.equal(rules.evaluate([timed,fallback],e('interrupted'),[],{stateDurationMs:8000}).decision.ruleId,'timed');
  assert.equal(rules.evaluate([timed,fallback],e('interrupted'),[],{stateDurationMs:8001}).decision.ruleId,'fallback');
});
test('duration filter validates integer bounds, order and context with no implicit wall clock',()=>{
  const base=r('a','finished');
  for(const bad of [NaN,-1,3600001,1.5,'5000',null]){
    assert.equal(rules.normalize([{...base,when:{phase:'finished',minDurationMs:bad}}]).error,'invalid-rule');
  }
  assert.equal(rules.normalize([{...base,when:{phase:'finished',minDurationMs:11,maxDurationMs:10}}]).error,'invalid-rule');
  for(const bad of [{stateDurationMs:-1},{stateDurationMs:3600001},{stateDurationMs:'5000'},{text:'forged'},null]){
    assert.equal(rules.evaluate([base],e(),[],bad).error,'invalid-context');
  }
  assert.equal(rules.evaluate([base],e()).decision.ruleId,'a');
});

test('rule dependencies and skip predicates are validated and deterministic',()=>{
  const prerequisite=r('prerequisite','failed','pause',100);
  const gated={...r('gated','finished','propose',50),
    when:{phase:'finished',dependsOn:['prerequisite']}};
  const fallback=r('fallback','finished','pause',10);
  const ruleset=[gated,fallback,prerequisite];
  assert.equal(rules.normalize(ruleset).ok,true);
  assert.equal(rules.evaluate(ruleset,e()).decision.ruleId,'fallback',
    'missing completed evidence must fail closed');
  const gatedResult=rules.evaluate(ruleset,e(),[],{completedRuleIds:['prerequisite']});
  assert.equal(gatedResult.ok,true);
  assert.equal(gatedResult.decision.ruleId,'gated');
  assert.equal(gatedResult.decision.approvalRequired,true);
  const skipped={...r('skipped','finished','pause',90),
    when:{phase:'finished',skipIf:['prerequisite']}};
  const selection=[prerequisite,skipped,gated,fallback];
  assert.equal(rules.evaluate(selection,e()).decision.ruleId,'skipped');
  assert.equal(rules.evaluate(selection,e(),[],{completedRuleIds:['prerequisite']}).decision.ruleId,'gated');
});
test('reject missing dependency, self dependency, cross-link contradictions and cycles',()=>{
  const base=r('a','finished'),b=r('b','failed');
  for(const candidate of [
    [{...base,when:{phase:'finished',dependsOn:['missing']}},b],
    [{...base,when:{phase:'finished',dependsOn:['a']}},b],
    [{...base,when:{phase:'finished',skipIf:['a']}},b],
    [{...base,when:{phase:'finished',dependsOn:['b'],skipIf:['b']}},b],
    [{...base,when:{phase:'finished',dependsOn:['b']}},
      {...b,when:{phase:'failed',dependsOn:['a']}}],
    [{...base,when:{phase:'finished',dependsOn:['b']}},
      {...b,when:{phase:'failed',dependsOn:['c']}},
      {...r('c','limit'),when:{phase:'limit',dependsOn:['a']}}],
  ])assert.equal(rules.normalize(candidate).error,'invalid-dependency');
});
test('reject overlong, repeated, non-string and invalid rule references',()=>{
  const base=r('a','finished'), b=r('b','failed');
  const bad=[
    ['b','b'],[7],[''],['bad id'],new Array(9).fill('b'),null,
    {0:'b',length:1}
  ];
  for(const links of bad) {
    assert.equal(rules.normalize([{...base,when:{phase:'finished',dependsOn:links}},b]).ok,false);
    assert.equal(rules.normalize([{...base,when:{phase:'finished',skipIf:links}},b]).ok,false);
  }
  const accepted=rules.normalize([{...base,when:{phase:'finished',dependsOn:['b']}},b]);
  assert.equal(accepted.ok,true);
  assert.equal(Object.isFrozen(accepted.rules[0].when.dependsOn),true);
  assert.equal(accepted.rules[0].when.dependsOn[0],'b');
});
test('simulated completion context is explicit, bounded and cannot be forged as executable code',()=>{
  const linked=[r('first','failed'),{...r('next','finished'),when:{phase:'finished',dependsOn:['first']}}];
  for(const completedRuleIds of [
    ['missing'],['first','first'],[null],42,'first',
    new Array(33).fill('first')
  ]){
    assert.equal(rules.evaluate(linked,e(),[],{completedRuleIds}).error,'invalid-context');
  }
  assert.equal(rules.evaluate(linked,e(),[],{completedRuleIds:['first'],script:'alert(1)'}).error,'invalid-context');
  assert.equal(rules.evaluate(linked,e(),[],{completedRuleIds:['first']}).decision.ruleId,'next');
  assert.equal(rules.evaluate(linked,e('finished','restored'),[],{completedRuleIds:['first']}).reason,'not-actionable');
  assert.equal(rules.evaluate(linked,e('finished','fresh',0),[],{completedRuleIds:['first']}).reason,'not-actionable');
});
