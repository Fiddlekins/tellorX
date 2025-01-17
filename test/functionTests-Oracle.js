const { AbiCoder } = require("@ethersproject/abi");
const { expect } = require("chai");
const h = require("./helpers/helpers");
var assert = require('assert');
const web3 = require('web3');
const { ethers } = require("hardhat");
const { stakeAmount } = require("./helpers/helpers");
const { keccak256 } = require("ethers/lib/utils");

describe("TellorX Function Tests - Oracle", function() {

  const tellorMaster = "0x88dF592F8eb5D7Bd38bFeF7dEb0fBc02cf3778a0"
  const DEV_WALLET = "0x39E419bA25196794B595B2a595Ea8E527ddC9856"
  const PARACHUTE = "0x83eB2094072f6eD9F57d3F19f54820ee0BaE6084"
  const BIGWALLET = "0xf977814e90da44bfa03b6295a0616a897441acec";
  let accounts = null
  let tellor = null
  let cfac,ofac,tfac,gfac,parachute,govBig,govTeam
  let govSigner = null

  beforeEach("deploy and setup TellorX", async function() {
    this.timeout(20000000)
    accounts = await ethers.getSigners();
    await hre.network.provider.request({
      method: "hardhat_reset",
      params: [{forking: {
            jsonRpcUrl: hre.config.networks.hardhat.forking.url,
            blockNumber:13037866

          },},],
      });
    await hre.network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [DEV_WALLET]}
    )
    await hre.network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [PARACHUTE]}
    )
    await hre.network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [BIGWALLET]}
    )
        //Steps to Deploy:
        //Deploy Governance, Oracle, Treasury, and Controller.
        //Fork mainnet Ethereum, changeTellorContract to Controller
        //run init in Controller

    oldTellorInstance = await ethers.getContractAt("contracts/tellor3/ITellor.sol:ITellor", tellorMaster)
    gfac = await ethers.getContractFactory("contracts/testing/TestGovernance.sol:TestGovernance");
    ofac = await ethers.getContractFactory("contracts/Oracle.sol:Oracle");
    tfac = await ethers.getContractFactory("contracts/Treasury.sol:Treasury");
    cfac = await ethers.getContractFactory("contracts/testing/TestController.sol:TestController");
    governance = await gfac.deploy();
    oracle = await ofac.deploy();
    treasury = await tfac.deploy();
    controller = await cfac.deploy();
    await governance.deployed();
    await oracle.deployed();
    await treasury.deployed();
    await controller.deployed();
    await accounts[0].sendTransaction({to:DEV_WALLET,value:ethers.utils.parseEther("1.0")});
    devWallet = await ethers.provider.getSigner(DEV_WALLET);
    bigWallet = await ethers.provider.getSigner(BIGWALLET);
    master = await oldTellorInstance.connect(devWallet)
    await master.proposeFork(controller.address);
    let _id = await master.getUintVar(h.hash("_DISPUTE_COUNT"))
    await master.vote(_id,true)
    master = await oldTellorInstance.connect(bigWallet)
    await master.vote(_id,true);
    await h.advanceTime(86400 * 8)
    await master.tallyVotes(_id)
    await h.advanceTime(86400 * 2.5)
    await master.updateTellor(_id)
    tellor = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",tellorMaster, devWallet);
    parachute = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",PARACHUTE, devWallet);
    govTeam = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",governance.address, devWallet);
    govBig = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",governance.address, bigWallet);
    await tellor.deployed();
    await tellor.init(governance.address,oracle.address,treasury.address)
    await hre.network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [governance.address]}
    )
    await accounts[1].sendTransaction({to:governance.address,value:ethers.utils.parseEther("1.0")});
    govSigner = await ethers.provider.getSigner(governance.address);
    });
  it("addTip()", async function() {
    this.timeout(20000000)
    var ts = await tellor.totalSupply()
    oracle1 = await ethers.getContractAt("contracts/Oracle.sol:Oracle",oracle.address, accounts[1]);
    h.expectThrow(oracle1.addTip(h.uintTob32(1),2,'0x'));//must have funds
    await tellor.transfer(accounts[1].address,web3.utils.toWei("200"))
    h.expectThrow(oracle1.addTip(h.uintTob32(1),0,'0x'));//tip must be greater than 0
    await oracle1.addTip(h.uintTob32(1),web3.utils.toWei("100"),'0x')
    assert(await oracle.getTipsByUser(accounts[1].address) == web3.utils.toWei("50"), "tips by user should be correct")
    assert(await oracle.getTipsById(h.uintTob32(1)) == web3.utils.toWei("50"), "tips by ID should be correct")
    assert(await oracle.tipsInContract() == web3.utils.toWei("50"), "tips in contract should be correct")
    var ts2 = await tellor.totalSupply()
    assert(ts - ts2  - web3.utils.toWei("50") < 100000000, "half of tip should be burned")//should be close enough (rounding errors)
    h.expectThrow(oracle1.addTip(h.hash("This is a test"),web3.utils.toWei("100"),'0x'))//ids greater than 100 should equal hash(bytes _data)
    await oracle1.addTip(h.hash("This is a test"),web3.utils.toWei("100"), web3.utils.toHex("This is a test"))
    assert(await oracle.getTipsByUser(accounts[1].address) == web3.utils.toWei("100"), "tips by user should be correct")
    assert(await oracle.getTipsById(h.hash("This is a test")) == web3.utils.toWei("50"), "tips by ID should be correct")
    assert(await oracle.tipsInContract() == web3.utils.toWei("100"), "tips in contract should be correct")
    var ts3 = await tellor.totalSupply()
    assert(ts2 - ts3  - web3.utils.toWei("50") < 100000000, "half of tip should be burned")//should be close enough (rounding errors)
  });
  it("submitValue()", async function() {
    await tellor.transfer(accounts[1].address,web3.utils.toWei("100"));
    await tellor.transfer(accounts[2].address,web3.utils.toWei("200"));
    tellorUser = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",tellorMaster, accounts[1]);
    let nonce = await oracle.getTimestampCountById(h.uintTob32(1));
    await h.expectThrow(oracle.submitValue( h.uintTob32(1),150,nonce));//must be staked
    await tellorUser.depositStake();
    tellorUser = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",tellorMaster, accounts[2]);
    await tellorUser.depositStake();
    oracle2 = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",oracle.address, accounts[2]);
    await oracle2.submitValue( h.uintTob32(2),150,nonce);//clear inflationary rewards
    await tellor.transfer(oracle.address,web3.utils.toWei("200"));//funding the oracle for inflationary rewards
    oracle = await ethers.getContractAt("contracts/Oracle.sol:Oracle",oracle.address, accounts[1]);
    await oracle2.addTip(h.uintTob32(1),web3.utils.toWei("10"),'0x')
    let initBal = await tellor.balanceOf(accounts[1].address)
    nonce = await oracle.getTimestampCountById(h.uintTob32(1));
    await oracle.submitValue( h.uintTob32(1),150,nonce);
    let blocky = await ethers.provider.getBlock();
    nonce = await oracle.getTimestampCountById(h.uintTob32(1));
    await h.expectThrow(oracle.submitValue( h.uintTob32(1),150,nonce));//cannot submit twice in 12 hours
    assert(await oracle.getValueByTimestamp(h.uintTob32(1),blocky.timestamp) - 150 == 0, "value should be correct")
    assert(await oracle.tipsInContract() == 0, "the tip should have been paid out")
    assert(await oracle.getTipsById(h.uintTob32(1)) == 0, "tips should be zeroed")
    assert(await oracle.getTimestampIndexByTimestamp(h.uintTob32(1),blocky.timestamp) == 0, "index should be correct")
    assert(await oracle.getReportTimestampByIndex(h.uintTob32(1),0) == blocky.timestamp, "timestamp should be correct")
    assert(await oracle.getTimestampCountById(h.uintTob32(1)) - 1 == 0, "timestamp count should be correct")
    assert(await oracle.getReportsSubmittedByAddress(accounts[1].address) - 1 == 0, "reports by address should be correct")
    assert(await oracle.timeOfLastNewValue()- blocky.timestamp == 0, "timeof last new value should be correct")
    assert(await tellor.balanceOf(accounts[1].address) - initBal - web3.utils.toWei("5") > 0, "reporter should be paid")
    assert(await tellor.balanceOf(accounts[1].address) - initBal - web3.utils.toWei("5.01") < 0, "reporter should be paid")
    assert(await oracle.getReporterByTimestamp(h.uintTob32(1),blocky.timestamp) == accounts[1].address, "reporter should be correct")
    assert(await oracle.getBlockNumberByTimestamp(h.uintTob32(1),blocky.timestamp) - blocky.number == 0, "blockNumber should be correct")
    await h.advanceTime(86400)
    admin = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",tellorMaster, govSigner);
    //increase stake amount, ensure failed until they put in more
    await admin.changeUint(h.hash("_STAKE_AMOUNT"),web3.utils.toWei("150"))
    nonce = await oracle.getTimestampCountById(h.uintTob32(1));
    await h.expectThrow(oracle.submitValue( h.uintTob32(1),150,nonce));//balance must be greater than stake amount
    await tellor.transfer(accounts[1].address,web3.utils.toWei("100"));
    await h.expectThrow(oracle.submitValue( h.uintTob32(1),150,nonce-1));//nonce must be correct
    oracle.submitValue(h.uintTob32(1),150,nonce)
});
  it("removeValue()", async function() {
    await tellor.transfer(accounts[1].address,web3.utils.toWei("100"));
    tellorUser = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",tellorMaster, accounts[1]);
    await tellorUser.depositStake();
    oracle = await ethers.getContractAt("contracts/Oracle.sol:Oracle",oracle.address, accounts[1]);
    await oracle.submitValue( h.uintTob32(1),150,0);
    let blocky = await ethers.provider.getBlock();
    await h.expectThrow(oracle.removeValue( ethers.utils.formatBytes32String("1"),blocky.timestamp));//must be governance
    admin = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",oracle.address, govSigner);
    await admin.removeValue( h.uintTob32(1),blocky.timestamp)
    assert(await oracle.getTimestampCountById(h.uintTob32(1))  == 0, "timestamp count should be correct")
    assert(await oracle.getTimestampIndexByTimestamp(h.uintTob32(1),blocky.timestamp) == 0, "index should be correct")
    assert(await oracle.getValueByTimestamp(h.uintTob32(1),blocky.timestamp) == "0x", "value should be correct")
  });
  it("getCurrentReward()", async function() {
    await tellor.transfer(accounts[1].address,web3.utils.toWei("105"));
    tellorUser = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",tellorMaster, accounts[1]);
    await tellorUser.depositStake();
    oracle = await ethers.getContractAt("contracts/Oracle.sol:Oracle",oracle.address, accounts[1]);
    await oracle.submitValue(h.uintTob32(1),150,0);
    let blocky1 = await ethers.provider.getBlock();
    await oracle.addTip(h.uintTob32(1),web3.utils.toWei("5"),'0x');
    await h.advanceTime(10000);
    let currentReward = await oracle.getCurrentReward(h.uintTob32(1));
    assert(currentReward[0] == web3.utils.toWei("2.5"), "Tip should be correct");
    assert(currentReward[1] == 0, "Current accumulated reward should be zero");
    await tellor.transfer(oracle.address, web3.utils.toWei("100"));
    let blocky2 = await ethers.provider.getBlock();
    let timeDiff = blocky2.timestamp - blocky1.timestamp;
    currentReward = await oracle.getCurrentReward(h.uintTob32(1));
    let tbr = await oracle.timeBasedReward();
    let expectedReward = tbr.mul(timeDiff).div(300);
    assert(currentReward[0] == web3.utils.toWei("2.5"), "Tips in contract should be correct");
    assert(expectedReward.eq(currentReward[1]), "Current accumulated tbr should be correct");
  });
  it("verify()", async function() {
    assert(await oracle.verify() > 9000, "Contract should properly verify")
  });
  it("changeMiningLock()", async function() {
    oracle = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",oracle.address, accounts[1]);
    await h.expectThrow(oracle.changeTimeBasedReward(web3.utils.toWei("1")))//must be admin
    admin = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",oracle.address, govSigner);
    await admin.changeMiningLock(86400)
    assert(await oracle.miningLock() - 86400 == 0, "mining lock should be changed")
  });
  it("changeTimeBasedReward()", async function() {
    oracle = await ethers.getContractAt("contracts/Oracle.sol:Oracle",oracle.address, accounts[1]);
    await h.expectThrow(oracle.changeTimeBasedReward(web3.utils.toWei("1")))//must be governance
    admin = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",oracle.address, govSigner);
    await admin.changeTimeBasedReward(web3.utils.toWei("1"))
    assert(await oracle.timeBasedReward() - web3.utils.toWei("1") == 0, "tbr should be changed")
  });
  it("getTipsById()", async function() {
    await tellor.transfer(accounts[1].address,web3.utils.toWei("100"));
    oracle = await ethers.getContractAt("contracts/Oracle.sol:Oracle",oracle.address, accounts[1]);
    await oracle.addTip(h.uintTob32(1),500,'0x')
    await oracle.addTip(h.uintTob32(1),500,'0x')
    assert(await oracle.getTipsById(h.uintTob32(1)) - 500 == 0, "tips should be correct")
  });
  it("getTimestampCountById()", async function() {
    await tellor.transfer(accounts[1].address,web3.utils.toWei("100"));
    await tellor.transfer(accounts[2].address,web3.utils.toWei("200"));
    tellorUser = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",tellorMaster, accounts[1]);
    await tellorUser.depositStake();
    tellorUser = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",tellorMaster, accounts[2]);
    await tellorUser.depositStake();
    oracle2 = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",oracle.address, accounts[2]);
    await oracle2.submitValue( h.uintTob32(2),150,0);//clear inflationary rewards
    await h.advanceTime(86400)
    oracle = await ethers.getContractAt("contracts/Oracle.sol:Oracle",oracle.address, accounts[1]);
    await oracle.submitValue( h.uintTob32(1),150,0);
    await oracle2.submitValue( h.uintTob32(1),150,1);
    assert(await oracle.getTimestampCountById(h.uintTob32(1)) - 2== 0, "timestamp count should be correct")
  });
  it("getTimestampIndexByTimestamp()", async function() {
    await tellor.transfer(accounts[1].address,web3.utils.toWei("100"));
    await tellor.transfer(accounts[2].address,web3.utils.toWei("200"));
    tellorUser = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",tellorMaster, accounts[1]);
    await tellorUser.depositStake();
    tellorUser = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",tellorMaster, accounts[2]);
    await tellorUser.depositStake();
    oracle2 = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",oracle.address, accounts[2]);
    await oracle2.submitValue( h.uintTob32(2),150,0);//clear inflationary rewards
    await h.advanceTime(86400)
    oracle = await ethers.getContractAt("contracts/Oracle.sol:Oracle",oracle.address, accounts[1]);
    await oracle.submitValue( h.uintTob32(1),150,0);
    await oracle2.submitValue( h.uintTob32(1),150,1);
    let blocky1 = await ethers.provider.getBlock();
    await h.advanceTime(86400)
    assert(await oracle.getTimestampIndexByTimestamp(h.uintTob32(1),blocky1.timestamp) == 1, "index should be correct")
    await oracle.submitValue( h.uintTob32(1),150,2);
    await oracle2.submitValue( h.uintTob32(1),150,3);
    let blocky2 = await ethers.provider.getBlock();
    // await h.advanceTime(86400)
    // await oracle.submitValue( ethers.utils.formatBytes32String("1"),150,4);
    // await oracle2.submitValue( ethers.utils.formatBytes32String("1"),150,5);
    assert(await oracle.getTimestampIndexByTimestamp(h.uintTob32(1),blocky2.timestamp) == 3, "index should be correct");
    admin = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",oracle.address, govSigner);
    await admin.removeValue( h.uintTob32(1),blocky1.timestamp);
    assert(await oracle.getTimestampIndexByTimestamp(h.uintTob32(1),blocky2.timestamp) == 2, "index should be correct");
  });
  it("getReportTimestampByIndex()", async function() {
    await tellor.transfer(accounts[1].address,web3.utils.toWei("100"));
    await tellor.transfer(accounts[2].address,web3.utils.toWei("200"));
    tellorUser = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",tellorMaster, accounts[1]);
    await tellorUser.depositStake();
    tellorUser = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",tellorMaster, accounts[2]);
    await tellorUser.depositStake();
    oracle2 = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",oracle.address, accounts[2]);
    await oracle2.submitValue( h.uintTob32(2),150,0);//clear inflationary rewards
    await h.advanceTime(86400)
    oracle = await ethers.getContractAt("contracts/Oracle.sol:Oracle",oracle.address, accounts[1]);
    await oracle.submitValue( h.uintTob32(1),150,0);
    await oracle2.submitValue( h.uintTob32(1),150,1);
    let blocky = await ethers.provider.getBlock();
    assert(await oracle.getReportTimestampByIndex(h.uintTob32(1),1) == blocky.timestamp, "timestamp should be correct")

  });
  it("getReportsSubmittedByAddress()", async function() {
    await tellor.transfer(accounts[1].address,web3.utils.toWei("100"));
    await tellor.transfer(accounts[2].address,web3.utils.toWei("200"));
    tellorUser = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",tellorMaster, accounts[1]);
    await tellorUser.depositStake();
    tellorUser = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",tellorMaster, accounts[2]);
    await tellorUser.depositStake();
    oracle2 = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",oracle.address, accounts[2]);
    await oracle2.submitValue( h.uintTob32(2),150,0);//clear inflationary rewards
    oracle = await ethers.getContractAt("contracts/Oracle.sol:Oracle",oracle.address, accounts[1]);
    await oracle.submitValue( h.uintTob32(1),150,0);
    await h.advanceTime(86400)
    await oracle.submitValue( h.uintTob32(1),150,1);
    await h.advanceTime(86400)
    await oracle.submitValue( h.uintTob32(1),150,2);
    await h.advanceTime(86400)
    await oracle.submitValue( h.uintTob32(1),150,3);
    let blocky = await ethers.provider.getBlock();
    assert(await oracle.getReportsSubmittedByAddress(accounts[1].address) - 4 == 0, "reports by address should be correct")
  });
  it("getTipsByUser()", async function() {
    await tellor.transfer(accounts[1].address,web3.utils.toWei("100"));
    oracle = await ethers.getContractAt("contracts/Oracle.sol:Oracle",oracle.address, accounts[1]);
    await oracle.addTip(h.uintTob32(1),500,'0x')
    await oracle.addTip(h.uintTob32(1),500,'0x')
    assert(await oracle.getTipsByUser(accounts[1].address) - 500 == 0, "tips should be correct")
  });
  it("getValueByTimestamp()", async function() {
    await tellor.transfer(accounts[1].address,web3.utils.toWei("100"));
    await tellor.transfer(accounts[2].address,web3.utils.toWei("200"));
    tellorUser = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",tellorMaster, accounts[1]);
    await tellorUser.depositStake();
    tellorUser = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",tellorMaster, accounts[2]);
    await tellorUser.depositStake();
    oracle2 = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",oracle.address, accounts[2]);
    oracle = await ethers.getContractAt("contracts/Oracle.sol:Oracle",oracle.address, accounts[1]);
    await oracle.submitValue( h.uintTob32(1),5550,0);
    let blocky = await ethers.provider.getBlock();
    await oracle2.submitValue( h.uintTob32(1),150,1);
    assert(await oracle.getValueByTimestamp(h.uintTob32(1),blocky.timestamp) - 5550 == 0, "value should be correct")
  });
  it("getCurrentValue()", async function() {
    await tellor.transfer(accounts[1].address,web3.utils.toWei("100"));
    await tellor.transfer(accounts[2].address,web3.utils.toWei("200"));
    tellorUser = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",tellorMaster, accounts[1]);
    await tellorUser.depositStake();
    tellorUser = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",tellorMaster, accounts[2]);
    await tellorUser.depositStake();
    oracle2 = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",oracle.address, accounts[2]);
    oracle = await ethers.getContractAt("contracts/Oracle.sol:Oracle",oracle.address, accounts[1]);
    await oracle.submitValue( h.uintTob32(1),5550,0);
    let blocky = await ethers.provider.getBlock();
    await oracle2.submitValue( h.uintTob32(1),150,1);
    assert(await oracle.getCurrentValue(h.uintTob32(1)) - 150 == 0, "value should be correct")
  });
  it("getBlockNumberByTimestamp()", async function() {
    await tellor.transfer(accounts[1].address,web3.utils.toWei("100"));
    await tellor.transfer(accounts[2].address,web3.utils.toWei("200"));
    tellorUser = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",tellorMaster, accounts[1]);
    await tellorUser.depositStake();
    tellorUser = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",tellorMaster, accounts[2]);
    await tellorUser.depositStake();
    oracle2 = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",oracle.address, accounts[2]);
    await oracle2.submitValue( ethers.utils.formatBytes32String("2"),150,0);//clear inflationary rewards
    await h.advanceTime(86400)
    oracle = await ethers.getContractAt("contracts/Oracle.sol:Oracle",oracle.address, accounts[1]);
    await oracle.submitValue( ethers.utils.formatBytes32String("1"),5550,0);
    let blocky = await ethers.provider.getBlock();
    await oracle2.submitValue( ethers.utils.formatBytes32String("1"),150,1);
    assert(await oracle.getBlockNumberByTimestamp(ethers.utils.formatBytes32String("1"),blocky.timestamp) - blocky.number == 0, "blockNumber should be correct")
  });
  it("getReporterByTimestamp()", async function() {
    await tellor.transfer(accounts[1].address,web3.utils.toWei("100"));
    await tellor.transfer(accounts[2].address,web3.utils.toWei("200"));
    tellorUser = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",tellorMaster, accounts[1]);
    await tellorUser.depositStake();
    tellorUser = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",tellorMaster, accounts[2]);
    await tellorUser.depositStake();
    oracle2 = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",oracle.address, accounts[2]);
    oracle = await ethers.getContractAt("contracts/Oracle.sol:Oracle",oracle.address, accounts[1]);
    await oracle.submitValue( ethers.utils.formatBytes32String("1"),5550,0);
    let blocky = await ethers.provider.getBlock();
    await oracle2.submitValue( ethers.utils.formatBytes32String("1"),150,1);
    let blocky2 = await ethers.provider.getBlock();
    assert(await oracle.getReporterByTimestamp(ethers.utils.formatBytes32String("1"),blocky.timestamp) == accounts[1].address, "reporter should be correct")
    assert(await oracle.getReporterByTimestamp(ethers.utils.formatBytes32String("1"),blocky2.timestamp) == accounts[2].address, "reporter2 should be correct")
  });
  it("getTimeOfLastNewValue()", async function() {
    await tellor.transfer(accounts[2].address,web3.utils.toWei("200"));
    tellorUser = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",tellorMaster, accounts[2]);
    await tellorUser.depositStake();
    oracle2 = await ethers.getContractAt("contracts/interfaces/ITellor.sol:ITellor",oracle.address, accounts[2]);
    await oracle2.submitValue( ethers.utils.formatBytes32String("2"),150,0);//clear inflationary rewards
    let blocky = await ethers.provider.getBlock();
    assert(await oracle.getTimeOfLastNewValue() - blocky.timestamp == 0, "blockNumber should be correct")
  });
  it("getTimeBasedReward()", async function() {
    let miningLock = await oracle.getTimeBasedReward()
    expect(miningLock).to.equal(BigInt(5E17))
  });

});
