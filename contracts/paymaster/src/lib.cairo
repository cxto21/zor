// SPDX-License-Identifier: MIT
// Zor Privacy Network — Dapp-Only Paymaster (Enshrined, SNIP-20)
//
// Only sponsors gas for transactions targeting allowed pool contracts.
// Owner funds the paymaster with STRK. Users pay nothing on Sepolia.
//
// Flow:
// 1. User builds tx: sender=pool, calldata=__execute__(compile_actions(...))
// 2. User includes paymaster_data = [pool_address]
// 3. Sequencer calls __validate_paymaster__
// 4. Paymaster checks pool is allowed → returns VALIDATED
// 5. Sequencer pays gas from paymaster's STRK balance

#[starknet::contract]
mod ZorPaymaster {
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess,
        StoragePointerReadAccess, StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_tx_info, get_caller_address};

    // ─── Events ───────────────────────────────────────────────

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        PoolAdded: PoolAdded,
        PoolRemoved: PoolRemoved,
        Sponsored: Sponsored,
    }

    #[derive(Drop, starknet::Event)]
    struct PoolAdded {
        pool: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    struct PoolRemoved {
        pool: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    struct Sponsored {
        pool: ContractAddress,
        user: ContractAddress,
    }

    // ─── Storage ──────────────────────────────────────────────

    #[storage]
    struct Storage {
        owner: ContractAddress,
        allowed_pools: Map<ContractAddress, bool>,
    }

    // ─── Constructor ──────────────────────────────────────────

    #[constructor]
    fn constructor(ref self: ContractState, owner: ContractAddress) {
        self.owner.write(owner);
    }

    // ─── Paymaster Entry Point ────────────────────────────────

    /// Called by the sequencer during V3 transaction processing.
    /// paymaster_data = [pool_address, ...]
    /// Returns VALIDATED if pool is allowed, reverts otherwise.
    #[external(v0)]
    fn __validate_paymaster__(
        ref self: ContractState,
    ) -> felt252 {
        let tx_info = get_tx_info().unbox();
        let paymaster_data = tx_info.paymaster_data;

        // Need at least 1 element: pool_address
        assert(paymaster_data.len() >= 1, 'Invalid paymaster data');

        let pool_address: ContractAddress = (*paymaster_data.at(0))
            .try_into()
            .expect('Invalid pool address');

        // Check pool is allowed
        assert(self.allowed_pools.read(pool_address), 'Pool not allowed');

        // Emit event
        let tx_info_inner = get_tx_info().unbox();
        self.emit(Sponsored {
            pool: pool_address,
            user: tx_info_inner.account_contract_address,
        });

        starknet::VALIDATED
    }

    // ─── Admin Functions ──────────────────────────────────────

    /// Add a pool to the allowed list. Only owner.
    #[external(v0)]
    fn add_allowed_pool(ref self: ContractState, pool: ContractAddress) {
        self._assert_owner();
        self.allowed_pools.write(pool, true);
        self.emit(PoolAdded { pool });
    }

    /// Remove a pool from the allowed list. Only owner.
    #[external(v0)]
    fn remove_allowed_pool(ref self: ContractState, pool: ContractAddress) {
        self._assert_owner();
        self.allowed_pools.write(pool, false);
        self.emit(PoolRemoved { pool });
    }

    /// Check if a pool is allowed.
    #[external(v0)]
    fn is_pool_allowed(self: @ContractState, pool: ContractAddress) -> bool {
        self.allowed_pools.read(pool)
    }

    /// Transfer ownership. Only owner.
    #[external(v0)]
    fn transfer_ownership(ref self: ContractState, new_owner: ContractAddress) {
        self._assert_owner();
        self.owner.write(new_owner);
    }

    /// Get current owner.
    #[external(v0)]
    fn get_owner(self: @ContractState) -> ContractAddress {
        self.owner.read()
    }

    // ─── Internal ─────────────────────────────────────────────

    #[generate_trait]
    impl Internal of InternalTrait {
        fn _assert_owner(self: @ContractState) {
            assert(get_caller_address() == self.owner.read(), 'Not owner');
        }
    }
}
