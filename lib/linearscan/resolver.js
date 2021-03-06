'use strict';

var linearscan = require('../linearscan');
var Gap = linearscan.Gap;

var assert = require('assert');

function Resolver(config) {
  this.config = config;

  this.intervals = config.intervals;
  this.instructions = config.instructions;
  this.positions = config.positions;
  this.liveIn = config.liveIn;
}
module.exports = Resolver;

Resolver.create = function create(config) {
  return new Resolver(config);
};

Resolver.prototype.resolve = function resolve() {
  this.resolveUses();
  this.resolveSplits();
  this.resolveFlow();
  this.resolveJumps();
};

Resolver.prototype.resolveUses = function resolveUses() {
  for (var i = 0; i < this.instructions.length; i++) {
    var instr = this.instructions[i];
    if (instr === null || instr.opcode.name === 'ls:gap')
      continue;

    var node = instr.node;
    if (instr.opcode.name === 'ssa:phi') {
      this.instructions[i] = null;
      this.resolvePhi(node);
      continue;
    }

    var out = this.intervals[node.index];
    if (out.value !== null && !out.value.isNone())
      instr.output = out.value;

    var opcode = instr.opcode;
    for (var j = 0; j < node.inputs.length; j++) {
      var input = this.intervals[node.inputs[j].index];

      var value = opcode.inputs[j];
      if (value.isFixed() || value.isNone())
        instr.inputs.push(value);
      // Check the interval's value right before the use
      else
        instr.inputs.push(input.childAt(instr.pos - 1).value);
    }
  }
};

Resolver.prototype.resolvePhi = function resolvePhi(phi) {
  var output = this.intervals[phi.index].value;

  // Phi does not have output, this means that it did not have any uses -
  // just skip it.
  if (output === null)
    return;

  for (var i = 0; i < phi.inputs.length; i++) {
    var pred = phi.block.predecessors[i];
    var predLast = pred.nodes[pred.nodes.length - 1];
    assert(predLast.isControl());

    var predPos = this.positions[predLast.index] - 1;

    var input = this.intervals[phi.inputs[i].index];

    var from = input.childAt(predPos).value;
    if (from.isEqual(output))
      continue;

    var gap = this.gap(predPos);
    gap.addMove(from, output);
  }
};

Resolver.prototype.resolveJumps = function resolveJumps() {
  for (var i = 0; i < this.instructions.length; i++) {
    var instr = this.instructions[i];
    if (instr === null)
      continue;
    if (instr instanceof Gap)
      continue;

    if (instr.opcode.isBranch)
      this.resolveControl(instr);
  }
};

Resolver.prototype.resolveFlow = function resolveFlow() {
  for (var i = 0; i < this.config.input.blocks.length; i++) {
    var block = this.config.input.blocks[i];
    if (block.successors.length === 0)
      continue;

    var last = this.positions[block.getLastControl().index];
    for (var j = 0; j < block.successors.length; j++) {
      var succ = block.successors[j];
      var succStart = this.positions[succ.index];

      var gapPos;
      if (block.successors.length === 2)
        gapPos = succStart;
      else
        gapPos = last;

      this.resolveSingleFlow(this.liveIn[succ.blockIndex],
                             last,
                             succStart,
                             gapPos);
    }
  }
};

Resolver.prototype.resolveSingleFlow = function resolveSingleFlow(live,
                                                                  fromPos,
                                                                  toPos,
                                                                  gapPos) {
  for (var j = 0; j < live.list.length; j++) {
    var node = live.list[j].value;
    var interval = this.intervals[node.index];

    var from = interval.childAt(fromPos).value;
    var to = interval.childAt(toPos).value;

    if (from.isEqual(to))
      continue;

    var gap = this.gap(gapPos);
    gap.addMove(from, to);
  }
};

Resolver.prototype.resolveControl = function resolveControl(instr) {
  var node = instr.node;
  for (var i = 0; i < node.controlUses.length; i += 2) {
    var control = node.controlUses[i];

    var pos = this.positions[control.index];
    while (this.instructions[pos] === null)
      pos++;

    instr.link(this.instructions[pos]);
  }
};

Resolver.prototype.resolveSplits = function resolveSplits() {
  for (var i = 0; i < this.intervals.length; i++) {
    var interval = this.intervals[i];

    var prev = interval;
    for (var j = 0; j < interval.children.length; j++) {
      var next = interval.children[j];
      this.resolveSplit(prev, next);
      prev = next;
    }
  }
};

Resolver.prototype.resolveSplit = function resolveSplit(from, to) {
  // Split happened in the life-time hole, will be handled by `resolveFlow`
  if (from.end() !== to.start())
    return;

  if (from.value.isEqual(to.value))
    return;

  // Fixed use splits intervals at odd places, make sure that move ordering is
  // correct.
  var gap = this.gap(from.end());
  if (gap.pos < from.end())
    gap.addPostMove(from.value, to.value);
  else
    gap.addMove(from.value, to.value);
};

Resolver.prototype.gap = function gap(pos) {
  return this.config.gap(pos);
};
