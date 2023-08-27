const { assert, expect } = require("chai");
const { deployments, ethers, getNamedAccounts, network } = require("hardhat");

const {
  developmentChains,
  networkConfig,
} = require("../../helper-hardhat.config");

!developmentChains.includes(network.name)
  ? describe.skip
  : describe("FundMe", async function () {
      let raffle, vrfCoordinatorV2Mock, entranceFee, deployer, interval, player;
      const chainId = network.config.chainId;

      beforeEach(async function () {
        accounts = await ethers.getSigners(); // could also do with getNamedAccounts
        deployer = accounts[0];
        player = accounts[1];
        await deployments.fixture(["mocks", "raffle"]); // Deploys modules with the tags "mocks" and "raffle"
        vrfCoordinatorV2Mock = await ethers.getContract("VRFCoordinatorV2Mock"); // Returns a new connection to the VRFCoordinatorV2Mock contract
        raffleContract = await ethers.getContract("Raffle"); // Returns a new connection to the Raffle contract
        raffle = raffleContract.connect(player); // Returns a new instance of the Raffle contract connected to player
        entranceFee = await raffle.getEntranceFee();
        interval = await raffle.getInterval();
      });

      describe("constructor", async function () {
        it("initialze raffle correctly", async function () {
          const RaffleState = await raffle.getRaffleState();

          assert.equal(RaffleState.toString(), "0");
          assert.equal(interval.toString(), networkConfig[chainId]["interval"]);
        });
      });

      describe("enterRaffle", async function () {
        it("reverts when they dont pay enough", async function () {
          await expect(raffle.enterRaffle()).to.be.rejectedWith(
            "Raffle__NotEnoughETHEntered"
          );
        });
        it("records player when they enter", async function () {
          await raffle.enterRaffle({ value: entranceFee });
          const contractPlayer = await raffle.getPlayers(0);
          assert.equal(player.address, contractPlayer);
        });
        it("emits an event", async function () {
          await expect(raffle.enterRaffle({ value: entranceFee })).to.emit(
            raffle,
            "RaffleEnter"
          );
        });
        it("doesnt allow entrance when raffle is calculating", async function () {
          await raffle.enterRaffle({ value: entranceFee });

          await network.provider.send("evm_increaseTime", [
            Number(interval) + 1,
          ]);
          //   await network.provider.request({ method: "evm_mine", params: [] });
          await network.provider.send("evm_mine");
          await raffle.performUpkeep(new Uint8Array());
          await expect(
            raffle.enterRaffle({ value: entranceFee })
          ).to.be.rejectedWith("Raffle__NotOpen");
        });
      });
      describe("checkUpkeep", function () {
        it("returns false if people haven't sent any ETH", async () => {
          await network.provider.send("evm_increaseTime", [
            Number(interval) + 1,
          ]);
          await network.provider.request({ method: "evm_mine", params: [] });
          const { upkeepNeeded } = await raffle.checkUpkeep.staticCall(
            new Uint8Array()
          );
          assert(!upkeepNeeded);
        });
        it("returns false if raffle isn't open", async () => {
          await raffle.enterRaffle({ value: entranceFee });
          await network.provider.send("evm_increaseTime", [
            Number(interval) + 1,
          ]);
          await network.provider.request({ method: "evm_mine", params: [] });
          await raffle.performUpkeep(new Uint8Array()); // changes the state to calculating
          const raffleState = await raffle.getRaffleState(); // stores the new state
          const { upkeepNeeded } = await raffle.checkUpkeep.staticCall(
            new Uint8Array()
          ); // upkeepNeeded = (timePassed && isOpen && hasBalance && hasPlayers)
          assert.equal(raffleState.toString(), "1");
          assert.equal(upkeepNeeded, false);
        });
        it("returns false if enough time hasn't passed", async () => {
          await raffle.enterRaffle({ value: entranceFee });
          await network.provider.send("evm_increaseTime", [
            Number(interval) - 5,
          ]); // use a higher number here if this test fails
          await network.provider.request({ method: "evm_mine", params: [] });
          const { upkeepNeeded } = await raffle.checkUpkeep.staticCall(
            new Uint8Array()
          ); // upkeepNeeded = (timePassed && isOpen && hasBalance && hasPlayers)
          assert(!upkeepNeeded);
        });
        it("returns true if enough time has passed, has players, eth, and is open", async () => {
          await raffle.enterRaffle({ value: entranceFee });
          await network.provider.send("evm_increaseTime", [
            Number(interval) + 1,
          ]);
          await network.provider.request({ method: "evm_mine", params: [] });
          const { upkeepNeeded } = await raffle.checkUpkeep.staticCall(
            new Uint8Array()
          ); // upkeepNeeded = (timePassed && isOpen && hasBalance && hasPlayers)
          assert(upkeepNeeded);
        });
      });

      describe("performUpkeep", function () {
        it("can only run if checkupkeep is true", async () => {
          await raffle.enterRaffle({ value: entranceFee });
          await network.provider.send("evm_increaseTime", [
            Number(interval) + 1,
          ]);
          await network.provider.request({ method: "evm_mine", params: [] });
          const tx = await raffle.performUpkeep("0x");
          assert(tx);
        });
        it("reverts if checkup is false", async () => {
          await expect(raffle.performUpkeep("0x")).to.be.rejectedWith(
            "Raffle__UpkeepNotEnough"
          );
        });
        it("updates the raffle state and emits a requestId", async () => {
          // Too many asserts in this test!
          await raffle.enterRaffle({ value: entranceFee });
          await network.provider.send("evm_increaseTime", [
            Number(interval) + 1,
          ]);
          await network.provider.request({ method: "evm_mine", params: [] });
          const txResponse = await raffle.performUpkeep("0x"); // emits requestId
          const txReceipt = await txResponse.wait(1); // waits 1 block
          const raffleDeployment = await deployments.get("Raffle");
          const raffleInterface = new ethers.Interface(raffleDeployment.abi);
          const parsedLogs = (txReceipt?.logs || []).map((log) => {
            return raffleInterface.parseLog({
              topics: [...log?.topics] || [],
              data: log?.data || "",
            });
          });
          const raffleState = await raffle.getRaffleState(); // updates state
          const requestId = parsedLogs[1]?.args[0] || BigInt(0);
          assert(Number(requestId) > 0);
          assert(raffleState == 1); // 0 = open, 1 = calculating
        });
      });
      describe("fulfillRandomWords", function () {
        beforeEach(async () => {
          await raffle.enterRaffle({ value: entranceFee });
          await network.provider.send("evm_increaseTime", [
            Number(interval) + 1,
          ]);
          await network.provider.request({ method: "evm_mine", params: [] });
        });
        it("can only be called after performupkeep", async () => {
          const raffleAddress = await raffle.getAddress();
          await expect(
            vrfCoordinatorV2Mock.fulfillRandomWords(0, raffleAddress) // reverts if not fulfilled
          ).to.be.rejectedWith("nonexistent request");
          await expect(
            vrfCoordinatorV2Mock.fulfillRandomWords(1, raffleAddress) // reverts if not fulfilled
          ).to.be.rejectedWith("nonexistent request");
        });

        // This test is too big...
        // This test simulates users entering the raffle and wraps the entire functionality of the raffle
        // inside a promise that will resolve if everything is successful.
        // An event listener for the WinnerPicked is set up
        // Mocks of chainlink keepers and vrf coordinator are used to kickoff this winnerPicked event
        // All the assertions are done once the WinnerPicked event is fired
        it("picks a winner, resets, and sends money", async () => {
          const additionalEntrances = 3; // to test
          const startingIndex = 2;
          let startingBalance;
          for (
            let i = startingIndex;
            i < startingIndex + additionalEntrances;
            i++
          ) {
            // i = 2; i < 5; i=i+1
            raffle = raffleContract.connect(accounts[i]); // Returns a new instance of the Raffle contract connected to player
            await raffle.enterRaffle({ value: entranceFee });
          }
          const startingTimeStamp = await raffle.getLatestTimestamp(); // stores starting timestamp (before we fire our event)

          // This will be more important for our staging tests...
          await new Promise(async (resolve, reject) => {
            raffle.once("WinnerPicked", async () => {
              // event listener for WinnerPicked
              const winnerEvent = raffle.getEvent("WinnerPicked");
              console.log("WinnerPicked event fired!");
              // assert throws an error if it fails, so we need to wrap
              // it in a try/catch so that the promise returns event
              // if it fails.
              try {
                // Now lets get the ending values...
                // const recentWinner = await raffle.getRecentWinner();
                const raffleState = await raffle.getRaffleState();
                // const winnerBalance = await accounts[2].getBalance();
                const endingTimeStamp = await raffle.getLatestTimestamp();
                // await expect(raffle.getPlayer(0)).to.be.reverted;
                // // Comparisons to check if our ending values are correct:
                // assert.equal(recentWinner.toString(), accounts[2].address);
                // assert.equal(raffleState, 0);
                // assert.equal(
                //   winnerBalance.toString(),
                //   startingBalance // startingBalance + ( (entranceFee * additionalEntrances) + entranceFee )
                //     .add(entranceFee.mul(additionalEntrances).add(entranceFee))
                //     .toString()
                // );
                // assert(endingTimeStamp > startingTimeStamp);
                const numberOfPlayers = await raffle.getNumberOfPlayers();

                assert(numberOfPlayers.toString(), "0");
                assert.equal(raffleState.toString(), "0");
                assert(endingTimeStamp > startingTimeStamp);
                resolve(); // if try passes, resolves the promise
              } catch (e) {
                reject(e); // if try fails, rejects the promise
              }
            });

            // kicking off the event by mocking the chainlink keepers and vrf coordinator
            try {
              //   const tx = await raffle.performUpkeep("0x");
              //   const txReceipt = await tx.wait(1);
              //   startingBalance = await accounts[2].getBalance();
              //   await vrfCoordinatorV2Mock.fulfillRandomWords(
              //     txReceipt.events[1].args.requestId,
              //     raffle.address
              //   );
              const txResponse = await raffle.performUpkeep(new Uint8Array());
              const txReceipt = await txResponse.wait(1);
              console.log("raffle performupkeep transaction mined");
              const raffleAddress = await raffle.getAddress();
              const parsedLogs = (txReceipt?.logs || []).map((log) => {
                return raffle.interface.parseLog({
                  topics: [...log?.topics] || [],
                  data: log?.data || "",
                });
              });
              const requestId = parsedLogs[1]?.args[0] || BigInt(0);
              await vrfCoordinatorV2Mock.fulfillRandomWords(
                requestId,
                raffleAddress
              );
              console.log("accounts[1]", accounts[1].address);
              console.log("accounts[2]", accounts[2].address);
              console.log("accounts[3]", accounts[3].address);
              console.log("accounts[4]", accounts[4].address);
              const winner = await raffle.getRecentWinner();
              console.log("winner", winner);
            } catch (e) {
              reject(e);
            }
          });
        });
      });
    });
