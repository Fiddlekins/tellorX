// SPDX-License-Identifier: MIT
pragma solidity 0.8.3;

import "./interfaces/IController.sol";
import "./TellorVars.sol";
import "hardhat/console.sol";

/**
 @author Tellor Inc.
 @title Oracle
 @dev This is the Oracle contract which defines the functionality for the Tellor
 * oracle, where reporters submit values on chain and users can retrieve values.
*/
contract Oracle is TellorVars {
    // Storage
    uint256 public tipsInContract; // number of tips within the contract
    uint256 public timeOfLastNewValue = block.timestamp; // time of the last new value, originally set to the block timestamp
    uint256 public miningLock = 12 hours; // amount of time before a reporter is able to submit a value again
    uint256 public timeBasedReward = 5e17; // time based reward for a reporter for successfully submitting a value
    mapping(bytes32 => uint256) public tips; // mapping of data IDs to the amount of TRB they are tipped
    mapping(bytes32 => Report) reports; // mapping of data IDs to a report
    mapping(address => uint256) reporterLastTimestamp; // mapping of reporter addresses to the timestamp of their last reported value
    mapping(address => uint256) reportsSubmittedByAddress; // mapping of reporter addresses to the number of reports they've submitted
    mapping(address => uint256) tipsByUser; // mapping of a user to the amount of tips they've paid
    bytes public lastNewValue; // The last value submitted across all feeds
    uint256 public targetDecayDuration = 5 minutes; // amount of time before all reporters are eligible to submit to a feed after it got tipped
    uint256 public minStakedBlockCount = 5 minutes / 13 seconds; // decay duration divided by current average block rate

    // Structs
    struct Report {
        uint256[] timestamps; // array of all newValueTimestamps requested
        mapping(uint256 => uint256) timestampIndex; // mapping of indices to respective timestamps
        mapping(uint256 => uint256) timestampToBlockNum; // mapping described by [apiId][minedTimestamp]=>block.number
        mapping(uint256 => bytes) valueByTimestamp; // mapping of timestamps to values
        mapping(uint256 => address) reporterByTimestamp; // mapping of timestamps to reporters
        uint256 target; // The current target
        uint256 lastTargetTimestamp; // Timestamp of the last time a tip triggered a new target
    }

    // Events
    event TipAdded(
        address indexed _user,
        bytes32 indexed _id,
        uint256 _tip,
        uint256 _totalTip,
        bytes _data
    );
    event NewReport(bytes32 _id, uint256 _time, bytes _value, uint256 _reward);
    event MiningLockChanged(uint256 _newMiningLock);
    event TimeBasedRewardsChanged(uint256 _newTimeBasedReward);

    /**
     * @dev Adds tips to incentivize reporters to submit values for specific data IDs.
     * @param _id is ID of the specific data feed
     * @param _tip is the amount to tip the given data ID
     * @param _data is required for IDs greater than 100, informs reporters how to fulfill request. See github.com/tellor-io/dataSpecs
     */
    function addTip(
        bytes32 _id,
        uint256 _tip,
        bytes memory _data
    ) external {
        // Require tip to be greater than 1 and be paid
        require(_tip > 1, "Tip should be greater than 1");
        require(
            IController(TELLOR_ADDRESS).approveAndTransferFrom(
                msg.sender,
                address(this),
                _tip
            ),
            "tip must be paid"
        );
        require(
            _id == keccak256(_data) ||
                uint256(_id) <= 100 ||
                msg.sender ==
                IController(TELLOR_ADDRESS).addresses(_GOVERNANCE_CONTRACT),
            "id must be hash of bytes data"
        );
        // Burn half the tip
        _tip = _tip / 2;
        IController(TELLOR_ADDRESS).burn(_tip);
        // Update total tip amount for user, data ID, and in total contract
        tips[_id] += _tip;
        tipsByUser[msg.sender] += _tip;
        tipsInContract += _tip;
        // Update target if appropriate
        Report storage rep = reports[_id];
        // Don't update target if an existing target has yet to fully decay to prevent censor attacks
        if ((rep.lastTargetTimestamp + targetDecayDuration) < block.timestamp){
            rep.lastTargetTimestamp = block.timestamp;
            rep.target = uint256(keccak256(abi.encodePacked(block.timestamp, lastNewValue)));
        }
        emit TipAdded(msg.sender, _id, _tip, tips[_id], _data);
    }

    /**
     * @dev Changes mining lock for reporters.
     * Note: this function is only callable by the Governance contract.
     * @param _newMiningLock is the new mining lock.
     */
    function changeMiningLock(uint256 _newMiningLock) external {
        require(
            msg.sender ==
                IController(TELLOR_ADDRESS).addresses(_GOVERNANCE_CONTRACT),
            "Only governance contract can change mining lock."
        );
        miningLock = _newMiningLock;
        emit MiningLockChanged(_newMiningLock);
    }

    /**
     * @dev Changes time based reward for reporters.
     * Note: this function is only callable by the Governance contract.
     * @param _newTimeBasedReward is the new time based reward.
     */
    function changeTimeBasedReward(uint256 _newTimeBasedReward) external {
        require(
            msg.sender ==
                IController(TELLOR_ADDRESS).addresses(_GOVERNANCE_CONTRACT),
            "Only governance contract can change time based reward."
        );
        timeBasedReward = _newTimeBasedReward;
        emit TimeBasedRewardsChanged(_newTimeBasedReward);
    }

    /**
     * @dev Removes a value from the oracle.
     * Note: this function is only callable by the Governance contract.
     * @param _id is ID of the specific data feed
     * @param _timestamp is the timestamp of the data value to remove
     */
    function removeValue(bytes32 _id, uint256 _timestamp) external {
        require(
            msg.sender ==
                IController(TELLOR_ADDRESS).addresses(_GOVERNANCE_CONTRACT),
            "caller must be the governance contract"
        );
        Report storage rep = reports[_id];
        uint256 _index = rep.timestampIndex[_timestamp];
        // Shift all timestamps back to reflect deletion of value
        for (uint256 i = _index; i < rep.timestamps.length - 1; i++) {
            rep.timestamps[i] = rep.timestamps[i + 1];
            rep.timestampIndex[rep.timestamps[i]] -= 1;
        }
        // Delete and reset timestamp and value
        delete rep.timestamps[rep.timestamps.length - 1];
        rep.timestamps.pop();
        rep.valueByTimestamp[_timestamp] = "";
        rep.timestampIndex[_timestamp] = 0;
    }

    /**
     * @dev Allows a reporter to submit a value to the oracle
     * @param _id is ID of the specific data feed
     * @param _value is the value the user submits to the oracle
     */
    function submitValue(
        bytes32 _id,
        bytes calldata _value,
        uint256 _nonce
    ) external {
        // Require reporter to abide by given mining lock
        require(
            block.timestamp - reporterLastTimestamp[msg.sender] > miningLock,
            "still in reporter time lock, please wait!"
        );
        reporterLastTimestamp[msg.sender] = block.timestamp;
        IController _tellor = IController(TELLOR_ADDRESS);
        // Checks that reporter is not already staking TRB
        (uint256 _status, ) = _tellor.getStakerInfo(msg.sender);
        require(_status == 1, "Reporter status is not staker");
        // Check is in case the stake amount increases
        require(
            _tellor.balanceOf(msg.sender) >= _tellor.uints(_STAKE_AMOUNT),
            "balance must be greater than stake amount"
        );
        // Checks for no double reporting of timestamps
        Report storage rep = reports[_id];
        require(
            _nonce == rep.timestamps.length,
            "nonce must match timestamp index"
        );
        require(
            rep.reporterByTimestamp[block.timestamp] == address(0),
            "timestamp already reported for"
        );
        uint256 _elapsedTime = block.timestamp - rep.lastTargetTimestamp;
        // skip if lastTargetTimestamp is in resting state or target has fully decayed
        if (rep.lastTargetTimestamp > 0 && _elapsedTime < targetDecayDuration){
            // Prevent automatic generation of new address that is eligible sooner by requiring an address to have been staked (roughly) before the target was set
            require(
                _tellor.balanceOfAt(msg.sender,block.number - minStakedBlockCount) >= _tellor.uints(_STAKE_AMOUNT),
                "balance must been greater than stake amount before target was set"
            );
            // Calculate eligibility
            uint256 _eligibility = uint256(keccak256(abi.encodePacked(rep.lastTargetTimestamp, msg.sender)));
            uint256 _smaller = rep.target > _eligibility ? _eligibility : rep.target;
            uint256 _larger = rep.target > _eligibility ? rep.target : _eligibility ;
            uint256 _distance = _larger - _smaller;
            uint256 _maxUint256 = uint256(-1);
            // if _distance is greater than half the range of a unit256 then wrapping around is closer
            if (_distance > (_maxUint256/2)){
                _distance = _smaller + (_maxUint256 - _larger);
            }
            // _distance has range [0,_maxUint256/2)
            // _distance / (_maxUint256/2) must be less than _elapsedTime / targetDecayDuration for this report attempt to eligible
            require(
                _distance <= (((_maxUint256/2)/targetDecayDuration) * _elapsedTime),
                "reporter address not yet eligible to submit"
            );
            // Set back to 0 so that we can skip this work until a new tip sets a target again
            rep.lastTargetTimestamp = 0;
        }

        // Update number of timestamps, value for given timestamp, and reporter for timestamp
        rep.timestampIndex[block.timestamp] = rep.timestamps.length;
        rep.timestamps.push(block.timestamp);
        rep.timestampToBlockNum[block.timestamp] = block.number;
        rep.valueByTimestamp[block.timestamp] = _value;
        rep.reporterByTimestamp[block.timestamp] = msg.sender;
        // Send tips + timeBasedReward to reporter of value, and reset tips for ID
        (uint256 _tip, uint256 _reward) = getCurrentReward(_id);
        tipsInContract -= _tip;
        if (_reward + _tip > 0) {
            _tellor.transfer(msg.sender, _reward + _tip);
        }
        tips[_id] = 0;
        // Update last oracle value and number of values submitted by a reporter
        timeOfLastNewValue = block.timestamp;
        reportsSubmittedByAddress[msg.sender]++;
        lastNewValue = _value;
        emit NewReport(_id, block.timestamp, _value, _tip + _reward);
    }

    //Getters
    /**
     * @dev Returns the block number at a given timestamp
     * @param _id is ID of the specific data feed
     * @param _timestamp is the timestamp to find the corresponding block number for
     * @return uint256 of the block number of the timestamp for the given data ID
     */
    function getBlockNumberByTimestamp(bytes32 _id, uint256 _timestamp)
        external
        view
        returns (uint256)
    {
        return reports[_id].timestampToBlockNum[_timestamp];
    }

    /**
     * @dev Calculates the current reward for a reporter given tips
     * and time based reward
     * @param _id is ID of the specific data feed
     */
    function getCurrentReward(bytes32 _id)
        public
        view
        returns (uint256, uint256)
    {
        IController _tellor = IController(TELLOR_ADDRESS);
        uint256 _timeDiff = block.timestamp - timeOfLastNewValue;
        uint256 _reward = (_timeDiff * timeBasedReward) / 300; //.5 TRB per 5 minutes (should we make this upgradeable)
        if (_tellor.balanceOf(address(this)) < _reward + tipsInContract) {
            _reward = _tellor.balanceOf(address(this)) - tipsInContract;
        }
        return (tips[_id], _reward);
    }

    /**
     * @dev Returns the current value of a data feed given a specific ID
     * @param _id is the ID of the specific data feed
     * @return bytes memory of the current value of data
     */
    function getCurrentValue(bytes32 _id) external view returns (bytes memory) {
        return
            reports[_id].valueByTimestamp[
                reports[_id].timestamps[reports[_id].timestamps.length - 1]
            ];
    }

    function getMiningLock() external view returns (uint256) {
        return miningLock;
    }

    /**
     * @dev Returns the address of the reporter who submitted a value for a data ID at a specific time
     * @param _id is ID of the specific data feed
     * @param _timestamp is the timestamp to find a corresponding reporter for
     * @return address of the reporter who reported the value for the data ID at the given timestamp
     */
    function getReporterByTimestamp(bytes32 _id, uint256 _timestamp)
        external
        view
        returns (address)
    {
        return reports[_id].reporterByTimestamp[_timestamp];
    }

    /**
     * @dev Returns the number of values submitted by a specific reporter address
     * @param _reporter is the address of a reporter
     * @return uint256 of the number of values submitted by the given reporter
     */
    function getReportsSubmittedByAddress(address _reporter)
        external
        view
        returns (uint256)
    {
        return reportsSubmittedByAddress[_reporter];
    }

    /**
     * @dev Returns the data the reporter client requires to determine when it's eligible to submit a value following a tip
     * @param _id is ID of the specific data feed
     * @return uint256 of the number of the current target and uint256 of the corresponding timestamp for the inputted data ID
     */
    function getTargetData(bytes _id)
        external
        view
        returns (uint256, uint256)
    {
        Report storage rep = reports[_id];
        return (rep.target, rep.lastTargetTimestamp);
    }

    /**
     * @dev Returns the time based reward for submitting a value
     * @return uint256 of time based reward
     */
    function getTimeBasedReward() external view returns (uint256) {
        return timeBasedReward;
    }

    /**
     * @dev Returns the number of timestamps/reports for a specific data ID
     * @param _id is ID of the specific data feed
     * @return uint256 of the number of the timestamps/reports for the inputted data ID
     */
    function getTimestampCountById(bytes32 _id)
        external
        view
        returns (uint256)
    {
        return reports[_id].timestamps.length;
    }

    /**
     * @dev Returns the timestamp of a reported value given a data ID and timestamp index
     * @param _id is ID of the specific data feed
     * @param _index is the index of the timestamp
     * @return uint256 of timestamp of the last oracle value
     */
    function getReportTimestampByIndex(bytes32 _id, uint256 _index)
        external
        view
        returns (uint256)
    {
        return reports[_id].timestamps[_index];
    }

    /**
     * @dev Returns the timestamp for the last value of any ID from the oracle
     * @return uint256 of timestamp of the last oracle value
     */
    function getTimeOfLastNewValue() external view returns (uint256) {
        return timeOfLastNewValue;
    }

    /**
     * @dev Returns the index of a reporter timestamp in the timestamp array for a specific data ID
     * @param _id is ID of the specific data feed
     * @param _timestamp is the timestamp to find in the timestamps array
     * @return uint256 of the index of the reporter timestamp in the array for specific ID
     */
    function getTimestampIndexByTimestamp(bytes32 _id, uint256 _timestamp)
        external
        view
        returns (uint256)
    {
        return reports[_id].timestampIndex[_timestamp];
    }

    /**
     * @dev Returns the number of tips made for a specific data feed ID
     * @param _id is ID of the specific data feed
     * @return uint256 of the number of tips made for the specific ID
     */
    function getTipsById(bytes32 _id) external view returns (uint256) {
        return tips[_id];
    }

    /**
     * @dev Returns the number of tips made by a user
     * @param _user is the address of the user
     * @return uint256 of the number of tips made by the user
     */
    function getTipsByUser(address _user) external view returns (uint256) {
        return tipsByUser[_user];
    }

    /**
     * @dev Returns the value of a data feed given a specific ID and timestamp
     * @param _id is the ID of the specific data feed
     * @param _timestamp is the timestamp to look for data
     * @return bytes memory of the value of data at the associated timestamp
     */
    function getValueByTimestamp(bytes32 _id, uint256 _timestamp)
        external
        view
        returns (bytes memory)
    {
        return reports[_id].valueByTimestamp[_timestamp];
    }

    /**
     * @dev Used during the upgrade process to verify valid Tellor Contracts
     */
    function verify() external pure returns (uint256) {
        return 9999;
    }
}
