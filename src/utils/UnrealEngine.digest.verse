# Copyright Epic Games, Inc. All Rights Reserved.
#################################################
# Generated Digest of Verse API
# DO NOT modify this manually!
# Generated from build: ++Fortnite+Release-41.10-CL-55335788
#################################################

Conversations<public> := module:
    using {/Verse.org/Chat}
    using {/Verse.org/Simulation}
    using {/Verse.org/SceneGraph}
    using {/Verse.org/Native}
    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    llm_prompt_error<native><public> := class:
        Message<native><public>:message

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    llm_prompt_timeout_error<native><public> := class(llm_prompt_error):

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    llm_prompt_throttled_error<native><public> := class(llm_prompt_error):

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    llm_prompt_moderated_error<native><public> := class(llm_prompt_error):

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    llm_prompt_character_limit_error<native><public> := class(llm_prompt_error):

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    # An abstraction around a recorded history of events and sending prompts with that history context included.
    llm_session<native><public> := class<unique>:
        # Removes all the history events from the session. Including conversation history.
        ClearHistory<native><public>()<transacts>:void

        @available {MinUploadedAtFNVersion := 4100}
        # The result will conform to the result type. The result type must be a struct which can contain.
        #  - numeric types, message, bools and enums, as well as structs or arrays which only contain those types, anything else results in an error.
        #  Use the names of the fields and name of the type of the struct to direct the prompt or facts on how to fill out the data structure.
        Prompt<native><public>((local:)Prompt:prompt, response_type:type)<suspends>:result(response_type, llm_prompt_error)

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    # Defines the way the persona will handle attempts to prompt it while it is processing.
    persona_interruption_rule<native><public> := enum<open>:
        # Cannot be interrupted, will ignore any input until the finished.
        IgnoreUntilFinished
        # Will be interrupted immediately when spoken to.
        InterruptOnPromptStart
        # Will interrupt when the response for the interrupting prompt is ready.
        InterruptOnResponseStart

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    # NPC Persona component
    persona_component<native><public> := class<final_super>(component):
        # The personality of the persona
        var Personality<public>:message = external {}

        # What the persona knows
        var Knowledge<public>:message = external {}

        # The session which will process all this persona's prompts
        # When the persona is in a voice channel, every session in that channel will automatically
        # propagate conversation history entries to all sessions found in the channel.
        # All and only conversation directly to or from a persona will be automatically recorded.
        var Session<public>:llm_session = external {}

        # The voice assigned to this persona.
        var Voice<public>:voice_model = external {}

        # How the persona will handle overlapping prompts.
        var InterruptionRule<public>:persona_interruption_rule = external {}

        # Listenable which is signaled when the player starts prompting the persona.
        StartHearEvent<native><public>:listenable(agent) = external {}

        # Listenable which is signaled when the player finishes prompting the persona.
        StopHearEvent<native><public>:listenable(agent) = external {}

        # Listenable which is signaled when the persona begins speaking (before moderation resolves).
        #  1/ The agent (if involved) that prompted the response.
        #  2/ Cancelable to stop the persona from talking.
        StartSayEvent<native><public>:listenable(tuple(?agent, cancelable)) = external {}

        # Listenable which is signaled when the spoken message is finalized (after moderation).
        #  Contains the actual message delivered — either the original or the canned replacement.
        #  1/ The agent (if involved) that prompted the response.
        #  2/ The final message that was said.
        CommitSayEvent<native><public>:listenable(tuple(?agent, message)) = external {}

        # Listenable which is signaled when the target stops talking.
        #  1/ logic that is true when interrupted
        StopSayEvent<native><public>:listenable(logic) = external {}

        # Requests the Persona to talk on the topic provided, requires the persona to be on a channel
        RequestToTalk<native><public>(Instructions:message)<transacts><decides>:void

        # Registers a callback for when the persona receives structured data in the format of response_type.
        #  Required forces this be filled out every time the persona is prompted.
        #  The returned cancelable unregisters this callback and stops the llm from attempting to send this kind of structured data.
        #  The result type must be a struct which can contain.
        #  - numeric types, message, bools and enums, as well as structs or arrays which only contain those types, anything else results in an error.
        #  Use the names of the fields and name of the type of the struct to direct the prompt or facts on how to fill out the data structure.
        SubscribeToResponseType<native><public>(response_type:type, Required:logic, Callback:type {_(:?agent, :response_type):void})<transacts>:cancelable

        @available {MinUploadedAtFNVersion := 4000}
        OnReceive<override>(SceneEvent:scene_event):logic = external {}

        # Listenable which is signaled when the persona was requested to talk, either by a player or prompt and failed.
        #  Callback receives:
        #    1) The persona which had the failure
        #    2) The error
        PromptFailureEvent<native><public>:listenable(llm_prompt_error) = external {}

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    # Sets the persona the player will attempt to prompt when they use the relevant hotkey.
    #  The persona must be in the voice channel with the player in order for the player to be able to successfully prompt.
    (Player:player where member_info:subtype(has_voice_member_info)).SetConversationTarget<native><public>((local:)Persona:persona_component, Channel:voice_channel(member_info))<transacts>:void

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    # Retrieve the persona and channel the player is currently bound to prompt.
    (Player:player).GetConversationTarget<native><public>()<reads><decides>:tuple(persona_component, voice_channel(has_voice_member_info))

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    # Unbind player from prompting personas
    (Player:player).ClearConversationTarget<native><public>()<transacts>:void

    @available {MinUploadedAtFNVersion := 4100}
    @experimental
    # Base class for all prompts sent to an llm session
    prompt<native><public> := class<abstract><castable><epic_internal>:

    @available {MinUploadedAtFNVersion := 4100}
    @experimental
    # A basic prompt for carrying out instructions
    basic_prompt<native><public> := class<final>(prompt):
        # What the llm should do
        var Instructions<native><public>:message

    @available {MinUploadedAtFNVersion := 4100}
    @experimental
    # A prompt which defines a persona and tells it to do something
    persona_prompt<native><public> := class<final>(prompt):
        # The personality of the persona
        var Personality<native><public>:message

        # What the persona knows
        var Knowledge<native><public>:message

        # What the persona should do
        var Instructions<native><public>:message

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    # The persona voice used when converting text-to-voice
    voice_model<native><public> := class<abstract><epic_internal>:

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    # Comic, High, Warm
    lily_voice<final><public> := class(voice_model):

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    # Refined, Med, Warm
    julienne_voice<final><public> := class(voice_model):

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    # Glamorous, Animated, warm
    victoria_voice<final><public> := class(voice_model):

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    # Tough, Low, Gravelly
    wyatt_voice<final><public> := class(voice_model):

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    # Comic, Med, Natural
    caleb_voice<final><public> := class(voice_model):

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    # Whimsical, High, Warm
    ethan_voice<final><public> := class(voice_model):

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    # Tough, Med, Natural
    vera_voice<final><public> := class(voice_model):

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    # Refined, Med, Natural
    grant_voice<final><public> := class(voice_model):

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    # Narrator, Low, Warm
    rex_voice<final><public> := class(voice_model):

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    # Whimsical, High, Warm
    luna_voice<final><public> := class(voice_model):

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    # Whimsical, Med, Warm
    chloe_voice<final><public> := class(voice_model):

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    # Tough, Med, Natural
    roxy_voice<final><public> := class(voice_model):

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    # Tough, Low, Natural
    vivienne_voice<final><public> := class(voice_model):

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    # Narrator, Med, Natural
    milo_voice<final><public> := class(voice_model):

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    # Cinematic, Med, Natural
    clara_voice<final><public> := class(voice_model):

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    # Comic, Med, Natural
    dante_voice<final><public> := class(voice_model):

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    # Cinematic, High, Natural
    marcus_voice<final><public> := class(voice_model):

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    # Whimsical, Med, Natural
    aria_voice<final><public> := class(voice_model):

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    # Comic, High, Natural
    victor_voice<final><public> := class(voice_model):

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    # Narrator, Med, Warm
    alaina_voice<final><public> := class(voice_model):

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    # Narrator, Low, Warm
    maisie_voice<final><public> := class(voice_model):

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    # Cinematic, Med, Warm
    arthur_voice<final><public> := class(voice_model):

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    # Comic, High, Natural
    felix_voice<final><public> := class(voice_model):

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    # Cinematic, Med, Natural
    walter_voice<final><public> := class(voice_model):

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    # Refined, Med, Warm
    simon_voice<final><public> := class(voice_model):

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    # Whimsical, High, Warm
    troy_voice<final><public> := class(voice_model):

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    # Tough, High, Warm
    brenna_voice<final><public> := class(voice_model):

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    # Tough, High, Natural
    marina_voice<final><public> := class(voice_model):

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    # Glamorous, Low, Natural
    helen_voice<final><public> := class(voice_model):

    @available {MinUploadedAtFNVersion := 4000}
    @experimental
    # Glamorous, Med, Natural
    graham_voice<final><public> := class(voice_model):

    @available {MinUploadedAtFNVersion := 4100}
    @experimental
    @attribscope_data
    @customattribhandler
    llm_description_attribute<public> := class<computes><internal>(attribute):
        Description<public>:string

    @available {MinUploadedAtFNVersion := 4100}
    @experimental
    llm_description<constructor><public>(Description:string)<computes>:llm_description_attribute = external {}

Progression<public> := module:
    using {/Verse.org/Progression}
    using {/Verse.org/Native}
    using {/Fortnite.com/Marketplace}
    @experimental
    # Grants an entitlement to each eligible participant.
    entitlement_quest_reward<native><public> := class(quest_reward):
        @available {MinUploadedAtFNVersion := 4000}
        # The entitlement type to grant.
        var Entitlement<native><public>:concrete_subtype(entitlement)

        # Quantity per participant.
        var Quantity<native><public>:int = external {}

        @available {MinUploadedAtFNVersion := 4000}
        # Iterates EligibleParticipants, resolves each participant's agent as a player,
        # and grants the entitlement via the platform entitlement service.
        GrantReward<override><native><final>(EligibleParticipants:[]quest_participant)<transacts>:result(void, []grant_quest_reward_error)

    @experimental
    # Tracks numeric progress toward a required count.
    # Complete when Progress >= RequiredCount.
    progress_quest_objective<native><public> := class(quest_objective):
        # Returns progress in "X / Y" format.
        GetProgress<override><native><final>()<reads>:message

        # Succeeds if Progress >= RequiredCount.
        IsComplete<override><native><final>()<reads><decides>:void

        # Sets current progress. Clamped to [0, RequiredCount].
        SetProgress<native><final><public>(Amount:float)<transacts>:void

        # Sets the target count. Clamped to [1, MaxFloat].
        SetRequiredCount<native><final><public>(Amount:float)<transacts>:void

        # Current progress toward RequiredCount.
        var<private> Progress<native><public>:float = external {}

        # Target count for completion.
        var<private> RequiredCount<native><public>:float

    using {/Verse.org/Presentation}
    using {/Verse.org/Assets}
    @experimental
    # Standard quest that follows the "do x, get y" paradigm.
    # Auto-completion: when Objective.IsComplete() succeeds, calls Complete() automatically.
    # Auto-rewarding: on completion, rewards are granted to eligible participants
    # via GetRecipients() then GrantReward().
    basic_quest<native><public> := class<abstract>(quest, has_icon, has_description):
        # Replaces the progression model on a live quest. Auto-completes if the new objective is
        # already completed.
        SetObjective<native><final><public>(InObjective:quest_objective)<transacts>:void

        # Progression model for the quest.
        var<private> Objective<native><public>:quest_objective

        # Rewards granted to eligible participants on completion.
        var Rewards<native><public>:[]quest_reward = external {}

    @experimental
    # Abstract base class for all quest objectives.
    quest_objective<native><public> := class<abstract>(has_icon, has_description):
        # Returns a progress message (e.g. "3 / 10").
        GetProgress<native><native_callable><public>()<reads>:message

        # Determines which participants can contribute to this objective.
        # Override to customize contributor selection.
        # Default: all participants where Info.Contributes = true.
        GetContributors<native><native_callable><public>(Memberships:[]quest_membership)<reads>:[]quest_participant

        # Succeeds if this objective is currently complete.
        IsComplete<native><native_callable><public>()<reads><decides>:void

        # Signals ProgressEvent. Call from a subclass to notify progress subscribers.
        SignalProgressEvent<native><final><protected>()<transacts>:void

        # Signaled when this objective is considered complete.
        CompleteEvent<native><final><public>:listenable(quest_objective) = external {}

        # Signaled when this objective's progress changes. Payload: this objective.
        ProgressEvent<native><final><public>:listenable(quest_objective) = external {}

    @experimental
    # Returned when a reward cannot be granted.
    grant_quest_reward_error<native><public> := class:

    @experimental
    # Abstract base class for all quest rewards.
    quest_reward<native><public> := class<abstract>(has_icon, has_description):
        # Determines which participants should receive this reward.
        # Override to customize recipient selection.
        # Default: all participants where Info.Receives = true.
        GetRecipients<native><native_callable><public>(Memberships:[]quest_membership)<reads>:[]quest_participant

        @available {MinUploadedAtFNVersion := 4000}
        # Grants this reward to the eligible participants.
        GrantReward<native><native_callable><public>(EligibleParticipants:[]quest_participant)<transacts>:result(void, []grant_quest_reward_error)

        # Signaled after this reward has been granted to recipients.
        GrantEvent<native><final><public>:listenable(tuple(quest_reward, []quest_participant)) = external {}

Itemization<public> := module:
    using {/Verse.org/Simulation}
    using {/Verse.org/Native}
    using {/Verse.org/SceneGraph}
    add_item_result<native><public> := class<epic_internal>:
        # Items that were newly added to this inventory as a result of the transaction.
        AddedItems<native><public>:[]entity

        # Items whose stack size changed as a result of the transaction, and the previous stack size value.
        ModifiedItems<native><public>:[]tuple(entity, int)

    remove_item_result<native><public> := class<epic_internal>:
        # The inventory which the item was removed from.
        Inventory<native><public>:inventory_component

        # Total stack count of items removed as a result of this transaction.
        RemovedAmount<native><public>:int

        # Items that were removed from this inventory as a result of the transaction.
        RemovedItems<native><public>:[]entity

        # Item whose stack size changed as a result of the transaction.
        ModifiedItem<native><public>:?tuple(entity, int)

    equip_item_result<native><public> := class<epic_internal>:
        Item<native><public>:entity

    unequip_item_result<native><public> := class<epic_internal>:
        Item<native><public>:entity

    # When adding an item, 'find_inventory_event' is used as a first pass to find the best inventory for an item. It is sent downwards.
    # 'add_item_query_event' can be used to veto inventory choices. It is sent upwards.
    find_inventory_event<native><public> := class<epic_internal>(scene_event):
        ItemComponent<native><public>:item_component

        var ChosenInventory<native><public>:?inventory_component = external {}

        var ChosenInventoryPriority<native><public>:float = external {}

    add_item_error<native><public> := class<computes>:

    # When adding an item, 'find_inventory_event' is used as a first pass to find the best inventory for an item. It is sent downwards.
    # 'add_item_query_event' can be used to veto inventory choices. It is sent upwards.
    add_item_query_event<native><public> := class<epic_internal>(scene_event):
        Item<native><public>:item_component

        Inventory<native><public>:inventory_component

        var<private> Errors<native><public>:[]add_item_error = external {}

        AddError<public>(Error:add_item_error):void = external {}

    remove_item_error<native><public> := class<computes>:

    remove_item_query_event<native><public> := class<epic_internal>(scene_event):
        Item<native><public>:item_component

        Inventory<native><public>:inventory_component

        var<private> Errors<native><public>:[]remove_item_error = external {}

        AddError<public>(Error:remove_item_error):void = external {}

    # Inventory components hold items. An entity with an inventory component can be considered to have an inventory.
    # The inventory component controls which items can enter or exit.
    # They also determine whether an item can be equipped.
    inventory_component<native><public> := class<final_super>(component):
        @available {MinUploadedAtFNVersion := 4000}
        OnReceive<override><native>(SceneEvent:scene_event):logic

        @available {MinUploadedAtFNVersion := 3800}
        # Adds the item to this inventory only, ignoring sub-inventories. Fails if no items could be added.
        AddItem<native><final><public>(Item:entity, ?AllowMergeItems:logic = external {})<transacts>:result(add_item_result, []add_item_error)

        @available {MinUploadedAtFNVersion := 3800}
        # Adds the item to this inventory, including sub-inventories. Fails if no items could be added.
        AddItemDistribute<native><final><public>(Item:entity, ?AllowMergeItems:logic = external {})<transacts>:result(add_item_result, []add_item_error)

        @available {MinUploadedAtFNVersion := 3800}
        # Removes an item from this inventory or its descendent inventories. Fails if the item could not be removed.
        RemoveItem<native><final><public>(Item:entity)<transacts>:result(remove_item_result, []remove_item_error)

        # Returns a list of items within this inventory only.
        GetItems<native><final><public>()<reads>:[]entity

        @available {MinUploadedAtFNVersion := 3200}
        # Returns a list of items (of a specific type) within this inventory only.
        GetItems<native><final><public>(Type:castable_subtype(item_component))<reads>:[]entity

        @available {MinUploadedAtFNVersion := 2930}
        # Returns a list of all items within this inventory and its descendant inventories.
        FindItems<native><final><public>()<reads>:generator(entity)

        @available {MinUploadedAtFNVersion := 3200}
        # Returns a list of all items (of a specific type) within this inventory and its descendant inventories.
        FindItems<native><final><public>(Type:castable_subtype(item_component))<reads>:[]entity

        # Returns a list of sub-inventories of this inventory only.
        GetInventories<native><final><public>()<reads>:[]inventory_component

        @available {MinUploadedAtFNVersion := 2930}
        # Returns a list of all sub-inventories within this inventory and its descendant inventories.
        FindInventories<native><final><public>()<reads>:generator(inventory_component)

        GetEquippedItems<final><native><public>():[]entity

        AddItemEvent<native><final><public>:listenable(add_item_result) = external {}

        RemoveItemEvent<native><final><public>:listenable(remove_item_result) = external {}

        EquipItemEvent<native><final><public>:listenable(equip_item_result) = external {}

        UnequipItemEvent<native><final><public>:listenable(unequip_item_result) = external {}

    @available {MinUploadedAtFNVersion := 3800}
    # Returns a failure reason (such as being full) if the provided item entity cannot be added. Does not consider sub-inventories.
    (Inventory:inventory_component).CanAddItem<native><public>(Item:entity, ?AllowMergeItems:logic = external {})<transacts>:result(false, []add_item_error)

    @available {MinUploadedAtFNVersion := 3800}
    # Returns a failure reason (such as being full) if the provided item entity cannot be added. AddItemDistribute allows the item to enter sub-inventories.
    (Inventory:inventory_component).CanAddItemDistribute<native><public>(Item:entity, ?AllowMergeItems:logic = external {})<transacts>:result(false, []add_item_error)

    @available {MinUploadedAtFNVersion := 3800}
    # Returns a failure reason if the provided item is not present or cannot be removed.
    (Inventory:inventory_component).CanRemoveItem<native><public>(Item:entity)<transacts>:result(false, []remove_item_error)

    # item_category is used to classify items.
    item_category<native><public> := class<castable><concrete><unique><allocates>:

    change_equipped_result<native><public> := class<epic_internal>:
        ItemComponent<native><public>:item_component

        IsItemEquipped<native><public>:logic

    change_inventory_result<native><public> := class<epic_internal>:
        ItemComponent<native><public>:item_component

        PreviousInventory<native><public>:?inventory_component

        CurrentInventory<native><public>:?inventory_component

    equip_item_error<native><public> := class<computes>:

    equip_item_query_event<native><public> := class(scene_event):
        Item<native><public>:item_component

        var<private> Errors<native><public>:[]equip_item_error = external {}

        AddError<public>(Error:equip_item_error):void = external {}

    unequip_item_error<native><public> := class<computes>:

    unequip_item_query_event<native><public> := class(scene_event):
        Item<native><public>:item_component

        var<private> Errors<native><public>:[]unequip_item_error = external {}

        AddError<public>(Error:unequip_item_error):void = external {}

    # Anything using this component should be considered an item. Required to interact with inventories.
    item_component<native><public> := class<final_super>(component):
        OnBeginSimulation<override>():void = external {}

        OnEndSimulation<override>():void = external {}

        # Returns the inventory_component this item currently resides in. Fails if it cannot find a valid parent inventory.
        GetParentInventory<native><final><public>()<reads><decides>:inventory_component

        # Succeeds if this item is considered currently within an inventory and equipped.
        IsEquipped<native><final><public>()<reads><decides>:void

        # Broadcast when this item changes inventory.
        ChangeInventoryEvent<native><final><public>:listenable(change_inventory_result) = external {}

        # Broadcast when this item is equipped or unequipped.
        ChangeEquippedEvent<native><final><public>:listenable(change_equipped_result) = external {}

        @available {MinUploadedAtFNVersion := 3800}
        # Attempts to equip this item within the inventory it is currently in.
        # Fails if not in an inventory or if equip_item_query_event contains any errors after querying.
        Equip<final><native><public>()<transacts>:result(false, []equip_item_error)

        @available {MinUploadedAtFNVersion := 3800}
        # Attempts to unequip this item.
        # Fails if not in an inventory, not currently equipped or if unequip_item_query_event contains any errors after querying.
        Unequip<final><native><public>()<transacts>:result(false, []unequip_item_error)

        @editable
        # Add one or more category instances to help define and organize this item.
        Categories<native><public>:[]item_category = external {}

        # Removes the item from its inventory and places it in the simulation world. Works on orphaned items i.e. outside the world or any inventory.
        #  Fails if the item is already a pickup. The transform of the item will not be altered except to unparent it from any inventory.
        (/UnrealEngine.com/Itemization/item_component:)Drop<native><public>()<transacts><decides>:void

        # Fails if this item is already in an inventory, or the inventory cannot accept the item.
        PickUp<native><public>(Inventory:inventory_component)<transacts><decides>:void

    @available {MinUploadedAtFNVersion := 3800}
    (Item:item_component).CanEquip<native><public>()<transacts>:result(false, []equip_item_error)

    @available {MinUploadedAtFNVersion := 3800}
    (Item:item_component).CanUnequip<native><public>()<transacts>:result(false, []unequip_item_error)

WebAPI<public> := module:
    # Usage:
    #     Licensed users create a derived version of `client_id` in their module.
    #     The Verse class path for your derived `client_id` is then used as the 
    #     configuration key in your backend service to map to your endpoint.
    # 
    #     WARNING: do not make your derived `client_id` class public. This object
    #     type is your private key to your backend.
    # 
    # Example:
    #     my_client_id<internal> := class<final><computes>(client_id)
    #     MyClient<internal> := MakeClient(my_client_id)
    client_id<native><public> := class<abstract><computes>:

    client<native><public> := class<final><computes><internal>:
        Get<native><public>(Path:string)<suspends>:response

    response<native><public> := class<internal>:

    body_response<native><public> := class<internal>(response):
        GetBody<native><public>()<computes>:string

    MakeClient<native><public>(ClientId:client_id)<converges>:client

Temporary<public> := module:
    # Module import path: /UnrealEngine.com/Temporary/UI
    (/UnrealEngine.com/Temporary:)UI<public> := module:
        using {/Verse.org/Colors}
        using {/Verse.org/Assets}
        using {/UnrealEngine.com/Temporary/SpatialMath}
        using {/Verse.org/Simulation}
        # Returns the `player_ui` associated with `Player`.
        # Fails if there is no `player_ui` associated with `Player`.
        GetPlayerUI<native><public>(Player:player)<transacts><decides>:player_ui

        # The main interface for adding and removing `widget`s to a player's UI.
        player_ui<native><public> := class<final><epic_internal>:
            # Adds `Widget` to this `player_ui` using default `player_ui_slot` configuration options.
            AddWidget<native><public>(Widget:widget):void

            # Adds `Widget` to this `player_ui` using `Slot` for configuration options.
            AddWidget<native><public>(Widget:widget, Slot:player_ui_slot):void

            # Removes `Widget` from this `player_ui`.
            RemoveWidget<native><public>(Widget:widget):void

            # Sets the user's focus on this `Widget`. The target `Widget`must be focusable, otherwise this has no effect.
            # If `SetFocus` is called before `AddWidget`, the `widget` will be focused after `AddWidget` is called, 
            # unless a SetFocus is called on a different `widget` by the time `AddWidget` is called.
            SetFocus<native><public>(Widget:widget):void

        # Base class for all UI elements drawn on the `player`'s screen.
        widget<native><public> := class<abstract><unique><epic_internal>:
            # Shows or hides the `widget` without removing itself from the containing `player_ui`.
            # See `widget_visibility` for details.
            SetVisibility<native><public>(InVisibility:widget_visibility):void

            # Returns the current `widget_visibility` state.
            GetVisibility<native><public>():widget_visibility

            # Enables or disables whether the `player` can interact with this `widget`.
            SetEnabled<native><public>(InIsEnabled:logic):void

            # `true` if this `widget` can be modified interactively by the player.
            IsEnabled<native><public>():logic

            # Returns the `widget`'s parent `widget`.
            # Fails if no parent exists, such as if this `widget` is not in the `player_ui` or is itself the root `widget`.
            GetParentWidget<native><public>()<transacts><decides>:widget

            # Returns the `widget` that added this `widget` to the `player_ui`. The root `widget` will return itself.
            # Fails if this `widget` is not in the `player_ui`.
            GetRootWidget<native><public>()<transacts><decides>:widget

        # `widget` creation configuration options.
        player_ui_slot<native><public> := struct:
            # Controls `widget` rendering order. Greater values will be draw in front of lesser values.
            ZOrder<native><public>:type {_X:int where 0 <= _X, _X <= 2147483647} = external {}

            # Controls `widget` input event consumption.
            InputMode<native><public>:ui_input_mode = external {}

        # `widget` input consumption mode.
        ui_input_mode<native><public> := enum:
            # `widget` does not consume any input.
            None
            # `widget` consumes all inputs
            All

        # Parameters for `event`s signalled by a `widget`.
        widget_message<native><public> := struct:
            # The `player` that triggered the `event`.
            Player<native><public>:player

            # The `widget` that triggered the `event`.
            Source<native><public>:widget

        # Used by `widget.SetVisibility` determine how a `widget` is shown in the user interface.
        widget_visibility<native><public> := enum:
            # The `widget` is visible and occupies layout space.
            Visible
            # The `widget` is invisible and does not occupy layout space.
            Collapsed
            # The `widget` is invisible and occupies layout space.
            Hidden

        # Used by`widget` orientation modes.
        orientation<native><public> := enum:
            # Orient `widget`s from left to right.
            Horizontal
            # Orient `widget`s from top to bottom.
            Vertical

        # `widget` horizontal alignment mode.
        horizontal_alignment<native><public> := enum:
            # Center `widget` horizontally within the slot.
            Center
            # Align `widget` to the left of the slot.
            Left
            # Align `widget` to the right of the slot.
            Right
            # `widget` fills the slot horizontally.
            Fill

        # `widget` vertical alignment mode.
        vertical_alignment<native><public> := enum:
            # Center `widget` vertically within the slot.
            Center
            # Align `widget` to the top of the slot.
            Top
            # Align `widget` to the bottom of the slot.
            Bottom
            # `widget` fills the slot vertically.
            Fill

        # The anchors of a `widget` determine its the position and sizing relative to its parent.
        # `anchor`s range from `(0.0, 0.0)` (left, top) to `(1.0, 1.0)` (right, bottom).
        anchors<native><public> := struct:
            # Holds the minimum anchors, (left, top). The valid range is between `0.0` and `1.0`.
            Minimum<native><public>:vector2 = external {}

            # Holds the maximum anchors, (right, bottom). The valid range is between `0.0` and `1.0`.
            Maximum<native><public>:vector2 = external {}

        # Specifies the gap outside each edge separating a `widget` from its neighbors.
        # Distance is measured in units where `1.0` unit is the width of a pixel at 1080p resolution.
        margin<native><public> := struct:
            # The left edge spacing.
            Left<native><public>:float = external {}

            # The top edge spacing.
            Top<native><public>:float = external {}

            # The right edge spacing.
            Right<native><public>:float = external {}

            # The bottom edge spacing.
            Bottom<native><public>:float = external {}

        # Button is a container of a single child widget slot and fires the OnClick event when the button is clicked.
        button<native><public> := class<final>(widget):
            # The child widget of the button. Used only during initialization of the widget and not modified by SetSlot.
            Slot<native><public>:button_slot

            # Sets the child widget slot.
            SetWidget<native><public>(InSlot:button_slot):void

            # Subscribable event that fires when the button is clicked.
            OnClick<public>():listenable(widget_message) = external {}

            HighlightEvent<public>():listenable(widget_message) = external {}

            UnhighlightEvent<public>():listenable(widget_message) = external {}

            # The UI input action that will trigger the Click event of this button.
            var TriggeringInputAction<public>:?input_action(logic) = external {}

        # Slot for button widget.
        button_slot<native><public> := struct:
            # The widget assigned to this slot.
            Widget<native><public>:widget

            # Horizontal alignment of the widget inside the slot.
            HorizontalAlignment<native><public>:horizontal_alignment = external {}

            # Vertical alignment of the widget inside the slot.
            VerticalAlignment<native><public>:vertical_alignment = external {}

            # Empty distance in pixels that surrounds the widget inside the slot. Assumes 1080p resolution.
            Padding<native><public>:margin = external {}

        # Canvas is a container widget that allows for arbitrary positioning of widgets in the canvas' slots.
        canvas<native><public> := class<final>(widget):
            # The child widgets of the canvas. Used only during initialization of the widget and not modified by Add/RemoveWidget.
            Slots<native><public>:[]canvas_slot = external {}

            # Adds a new child slot to the canvas.
            AddWidget<native><public>(Slot:canvas_slot):void

            # Removes a slot containing the given widget.
            RemoveWidget<native><public>(Widget:widget):void

        # Slot for a canvas widget.
        canvas_slot<native><public> := struct:
            # The border for the margin and how the widget is resized with its parent.
            # Values are defined between 0.0 and 1.0.
            Anchors<native><public>:anchors = external {}

            # The offset that defined the size and position of the widget.
            # When the anchors are well defined, the Offsets.Left represent the distance in pixels from the Anchors Minimum.X, the Offsets.Bottom represent the distance in pixel from the Anchors Maximum.Y, effectively controlling the desired widget size. When the anchors are not well defined, the Offsets.Left and Offsets.Top represent the widget position and Offsets.Right and Offset.Bottom represent the widget size.
            Offsets<native><public>:margin = external {}

            # When true we use the widget's desired size. The size calculated by the Offsets is ignored.
            SizeToContent<native><public>:logic = external {}

            # Alignment is the pivot/origin point of the widget.
            # Starting in the upper left at (0.0,0.0), ending in the lower right at (1.0,1.0).
            Alignment<native><public>:vector2 = external {}

            # Z Order of this slot relative to other slots in this canvas panel.
            # Higher values are rendered last (and so they will appear to be on top)
            ZOrder<native><public>:type {_X:int where 0 <= _X, _X <= 2147483647} = external {}

            # The widget assigned to this slot.
            Widget<native><public>:widget

        # Make a canvas slot for fixed position widget.
        # If Size is set, then the Offsets is calculated and the SizeToContent is set to false.
        # If Size is not set, then Right and Bottom are set to zero and are not used. The widget size will be automatically calculated. The SizeToContent is set to true.
        # The widget is not anchored and will not move if the parent is resized.
        # The Anchors is set to zero.
        MakeCanvasSlot<native><public>(Widget:widget, Position:vector2, ?Size:vector2 = external {}, ?ZOrder:type {_X:int where 0 <= _X, _X <= 2147483647} = external {}, ?Alignment:vector2 = external {})<computes>:canvas_slot

        # A solid color widget.
        color_block<native><public> := class<final>(widget):
            # The color of the widget. Used only during initialization of the widget and not modified by SetColor.
            DefaultColor<native><public>:color = external {}

            # The opacity of the widget. Used only during initialization of the widget and not modified by SetOpacity.
            DefaultOpacity<native><public>:type {_X:float where 0.000000 <= _X, _X <= 1.000000} = external {}

            # The size this widget desired to be displayed in. Used only during initialization of the widget and not modified by SetDesiredSize.
            DefaultDesiredSize<native><public>:vector2 = external {}

            # Sets the widget's color.
            SetColor<native><public>(InColor:color):void

            # Gets the widget's color.
            GetColor<native><public>():color

            # Sets the widgets's opacity.
            SetOpacity<native><public>(InOpacity:type {_X:float where 0.000000 <= _X, _X <= 1.000000}):void

            # Gets the widget's opacity.
            GetOpacity<native><public>():type {_X:float where 0.000000 <= _X, _X <= 1.000000}

            # Sets the size this widget desired to be displayed in.
            SetDesiredSize<native><public>(InDesiredSize:vector2):void

            # Gets the size this widget desired to be displayed in.
            GetDesiredSize<native><public>():vector2

        # Tiling options values
        image_tiling<native><public> := enum:
            # Stretch the image to fit the available space.
            Stretch
            # Repeat/Wrap the image to fill the available space.
            Repeat

        # A widget to display a texture.
        texture_block<native><public> := class(widget):
            # The image to render. Used only during initialization of the widget and not modified by SetImage.
            DefaultImage<native><public>:texture

            # Tinting applied to the image. Used only during initialization of the widget and not modified by SetTint.
            DefaultTint<native><public>:color = external {}

            # The size this widget desired to be displayed in. Used only during initialization of the widget and not modified by SetDesiredSize.
            DefaultDesiredSize<native><public>:vector2 = external {}

            # The horizontal tiling option. Used only during initialization of the widget and not modified by SetTiling.
            DefaultHorizontalTiling<native><public>:image_tiling = external {}

            # The vertical tiling option. Used only during initialization of the widget and not modified by SetTiling.
            DefaultVerticalTiling<native><public>:image_tiling = external {}

            # Sets the image to render.
            SetImage<native><public>(InImage:texture):void

            # Gets the image to render.
            GetImage<native><public>():texture

            # Sets the tint applied to the image.
            SetTint<native><public>(InColor:color):void

            # Gets the tint applied to the image.
            GetTint<native><public>():color

            # Sets the size this widget desired to be displayed in.
            SetDesiredSize<native><public>(InDesiredSize:vector2):void

            # Gets the size this widget desired to be displayed in.
            GetDesiredSize<native><public>():vector2

            # Sets the tiling option when the image is smaller than the allocated size.
            SetTiling<native><public>(InHorizontalTiling:image_tiling, InVerticalTiling:image_tiling):void

            # Gets the tiling option.
            GetTiling<native><public>():tuple(image_tiling, image_tiling)

        # A widget to display a material.
        material_block<native><public> := class(widget):
            # The image to render. Used only during initialization of the widget and not modified by SetImage.
            DefaultImage<native><public>:material

            # Tinting applied to the image. Used only during initialization of the widget and not modified by SetTint.
            DefaultTint<native><public>:color = external {}

            # The size this widget desired to be displayed in. Used only during initialization of the widget and not modified by SetDesiredSize.
            DefaultDesiredSize<native><public>:vector2 = external {}

            # Sets the image to render.
            SetImage<native><public>(InImage:material):void

            # Gets the image to render.
            GetImage<native><public>():material

            # Sets the tint applied to the image.
            SetTint<native><public>(InColor:color):void

            # Gets the tint applied to the image.
            GetTint<native><public>():color

            # Sets the size this widget desired to be displayed in.
            SetDesiredSize<native><public>(InDesiredSize:vector2):void

            # Gets the size this widget desired to be displayed in.
            GetDesiredSize<native><public>():vector2

        # Overlay is a container consisting of widgets stacked on top of each other.
        overlay<native><public> := class<final>(widget):
            # The child widgets of the overlay. Used only during initialization of the widget and not modified by Add/RemoveWidget.
            Slots<native><public>:[]overlay_slot = external {}

            # Add a new child slot to the overlay. Slots are added at the end.
            AddWidget<native><public>(Slot:overlay_slot):void

            # Removes a slot containing the given widget
            RemoveWidget<native><public>(Widget:widget):void

        # Slot for an overlay widget
        overlay_slot<native><public> := struct:
            # The widget assigned to this slot.
            Widget<native><public>:widget

            # Horizontal alignment of the widget inside the slot.
            # This alignment is only applied after the layout space for the widget slot is created and determines the widget alignment within that space.
            HorizontalAlignment<native><public>:horizontal_alignment = external {}

            # Vertical alignment of the widget inside the slot.
            # This alignment is only applied after the layout space for the widget slot is created and determines the widget alignment within that space.
            VerticalAlignment<native><public>:vertical_alignment = external {}

            # Empty distance in pixels that surrounds the widget inside the slot. Assumes 1080p resolution.
            Padding<native><public>:margin = external {}

        # Stack box is a container of a list of widgets stacked either vertically or horizontally.
        stack_box<native><public> := class<final>(widget):
            # The child widgets of the stack box. Used only during initialization of the widget and not modified by Add/RemoveWidget.
            Slots<native><public>:[]stack_box_slot = external {}

            # The orientation of the stack box. Either stack widgets horizontal or vertical.
            Orientation<native><public>:orientation

            # Add a new child slot to the stack box. Slots are added at the end.
            AddWidget<native><public>(Slot:stack_box_slot):void

            # Removes a slot containing the given widget
            RemoveWidget<native><public>(Widget:widget):void

        # Slot for a stack_box widget
        stack_box_slot<native><public> := struct:
            # The widget assigned to this slot.
            Widget<native><public>:widget

            # Horizontal alignment of the widget inside the slot.
            # This alignment is only applied after the layout space for the widget slot is created and determines the widget alignment within that space.
            HorizontalAlignment<native><public>:horizontal_alignment = external {}

            # Vertical alignment of the widget inside the slot.
            # This alignment is only applied after the layout space for the widget slot is created and determines the widget alignment within that space.
            VerticalAlignment<native><public>:vertical_alignment = external {}

            # Empty distance in pixels that surrounds the widget inside the slot. Assumes 1080p resolution.
            Padding<native><public>:margin = external {}

            # The available space will be distributed proportionally.
            # If not set, the slot will use the desired size of the widget.
            Distribution<native><public>:?float = external {}

        # Text justification values:
        #   Left: Justify the text logically to the left based on current culture.
        #   Center: Justify the text in the center.
        #   Right: Justify the text logically to the right based on current culture.
        # The Left and Right value will flip when the local culture is right-to-left.
        text_justification<native><public> := enum:
            Left
            Center
            Right
            InvariantLeft
            InvariantRight

        # Text overflow policy values:
        #   Clip: Overflowing text will be clipped.
        #   Ellipsis: Overflowing text will be replaced with an ellipsis.
        text_overflow_policy<native><public> := enum:
            Clip
            Ellipsis

        # Text wrapping policy values:
        #   LineBreak: Allows breaking a line only at line-break iterator for wrapping.
        #   PerCharacter: Allows breaking a line after any character for wrapping.
        text_wrapping_policy<native><public> := enum:
            LineBreak
            PerCharacter

        # Base widget for text widget.
        text_base<native><public> := class<abstract>(widget):
            # The text to display to the user. Used only during initialization of the widget and not modified by SetText.
            DefaultText<native><localizes><public>:message = external {}

            # The color of the displayed text. Used only during initialization of the widget and not modified by SetTextColor.
            DefaultTextColor<native><public>:color = external {}

            # The size of the displayed text. Used only during initialization of the widget and not modified by SetTextSize.
            DefaultTextSize<native><public>:float = external {}

            # The opacity of the displayed text. Used only during initialization of the widget and not modified by SetTextOpacity.
            DefaultTextOpacity<native><public>:type {_X:float where 0.000000 <= _X, _X <= 1.000000} = external {}

            # The justification to display to the user. Used only during initialization of the widget and not modified by SetJustification.
            DefaultJustification<native><public>:text_justification = external {}

            # The policy that determine what happens when the text is longer than its allowed length.
            # Used only during initialization of the widget and not modified by SetOverflowPolicy.
            DefaultOverflowPolicy<native><public>:text_overflow_policy = external {}

            # Whether the text should be automatically wrapped.
            var AutoWrap<public>:logic = external {}

            # Whether text wraps onto a new line when it's length exceeds this width; if this value is zero or negative, no wrapping occurs.
            var WrapWidth<public>:float = external {}

            # The wrapping policy to determine where the line can be broken.
            var WrappingPolicy<public>:text_wrapping_policy = external {}

            # Sets the text displayed in the widget.
            SetText<native><public>(InText:message):void

            # Gets the text currently in the widget.
            GetText<native><public>():string

            # Sets the text justification in the widget.
            SetJustification<native><public>(InJustification:text_justification):void

            # Gets the text justification in the widget.
            GetJustification<native><public>():text_justification

            # Sets the policy that determine what happens when the text is longer than its allowed length.
            SetOverflowPolicy<native><public>(InOverflowPolicy:text_overflow_policy):void

            # Gets the policy that determine what happens when the text is longer than its allowed length.
            GetOverflowPolicy<native><public>():text_overflow_policy

            # Sets the color of the displayed text.
            SetTextColor<native><public>(InColor:color):void

            # Gets the color of the displayed text.
            GetTextColor<native><public>():color

            # Sets the size of the displayed text.
            SetTextSize<native><public>(InSize:float):void

            # Gets the size of the displayed text.
            GetTextSize<native><public>():float

            # Sets the opacity of the displayed text.
            SetTextOpacity<native><public>(InOpacity:type {_X:float where 0.000000 <= _X, _X <= 1.000000}):void

            # Gets the opacity of the displayed text.
            GetTextOpacity<native><public>():type {_X:float where 0.000000 <= _X, _X <= 1.000000}

    # Module import path: /UnrealEngine.com/Temporary/Curves
    Curves<public> := module:
        editable_curve<native><public> := class<final><concrete>:
            # Evaluates this float curve at the specified time and returns the result as a float
            Evaluate<native><public>(Time:float):float

    # Module import path: /UnrealEngine.com/Temporary/Diagnostics
    Diagnostics<public> := module:
        using {/UnrealEngine.com/Temporary/SpatialMath}
        using {/Verse.org/Colors}
        using {/Verse.org/SpatialMath}
        # Enumerated presets for policies describing a desired draw duration.
        debug_draw_duration_policy<native><public> := enum:
            SingleFrame
            FiniteDuration
            Persistent

        # debug_draw_channel is the base class used to define debug draw channels.
        debug_draw_channel<native><public> := class<abstract>:

        # debug draw class to draw debug shapes on screen.
        debug_draw<native><public> := class:
            # Channel will be used to clear specific debug draw.
            Channel<native><public>:subtype(debug_draw_channel) = external {}

            # Show Debug Draw for the channel for all users.
            ShowChannel<native><public>()<transacts>:void

            # Hide Debug Draw for the channel for all users.
            HideChannel<native><public>()<transacts>:void

            # Clears all debug draw for the channel.
            ClearChannel<native><public>()<transacts>:void

            # Clears all debug draw from this debug_draw instance.
            Clear<native><public>()<transacts>:void

            # Draws a sphere at the named location, and using the provided draw parameters.
            DrawSphere<native><public>(Center:(/Verse.org/SpatialMath:)vector3, ?Radius:float = external {}, ?Color:color = external {}, ?NumSegments:int = external {}, ?Thickness:float = external {}, ?DrawDurationPolicy:debug_draw_duration_policy = external {}, ?Duration:float = external {})<transacts>:void

            # Draws a sphere at the named location, and using the provided draw parameters.
            DrawSphere<public>(Center:(/UnrealEngine.com/Temporary/SpatialMath:)vector3, ?Radius:float = external {}, ?Color:color = external {}, ?NumSegments:int = external {}, ?Thickness:float = external {}, ?DrawDurationPolicy:debug_draw_duration_policy = external {}, ?Duration:float = external {})<transacts>:void = external {}

            # Draws a box at the named location, and using the provided draw parameters
            DrawBox<native><public>(Center:(/Verse.org/SpatialMath:)vector3, Rotation:(/Verse.org/SpatialMath:)rotation, ?Extent:(/Verse.org/SpatialMath:)vector3 = external {}, ?Color:color = external {}, ?Thickness:float = external {}, ?DrawDurationPolicy:debug_draw_duration_policy = external {}, ?Duration:float = external {})<transacts>:void

            # Draws a box at the named location, and using the provided draw parameters
            DrawBox<public>(Center:(/UnrealEngine.com/Temporary/SpatialMath:)vector3, Rotation:(/UnrealEngine.com/Temporary/SpatialMath:)rotation, ?Extent:(/UnrealEngine.com/Temporary/SpatialMath:)vector3 = external {}, ?Color:color = external {}, ?Thickness:float = external {}, ?DrawDurationPolicy:debug_draw_duration_policy = external {}, ?Duration:float = external {})<transacts>:void = external {}

            # Draws a capsule at the named location, and using the provided draw parameters.
            DrawCapsule<native><public>(Center:(/Verse.org/SpatialMath:)vector3, Rotation:(/Verse.org/SpatialMath:)rotation, ?Height:float = external {}, ?Radius:float = external {}, ?Color:color = external {}, ?Thickness:float = external {}, ?DrawDurationPolicy:debug_draw_duration_policy = external {}, ?Duration:float = external {})<transacts>:void

            # Draws a capsule at the named location, and using the provided draw parameters.
            DrawCapsule<public>(Center:(/UnrealEngine.com/Temporary/SpatialMath:)vector3, Rotation:(/UnrealEngine.com/Temporary/SpatialMath:)rotation, ?Height:float = external {}, ?Radius:float = external {}, ?Color:color = external {}, ?Thickness:float = external {}, ?DrawDurationPolicy:debug_draw_duration_policy = external {}, ?Duration:float = external {})<transacts>:void = external {}

            # Draws a cone at the named location, and using the provided draw parameters.
            DrawCone<native><public>(Origin:(/Verse.org/SpatialMath:)vector3, Direction:(/Verse.org/SpatialMath:)vector3, ?Height:float = external {}, ?NumSides:int = external {}, ?AngleWidthRadians:float = external {}, ?AngleHeightRadians:float = external {}, ?Color:color = external {}, ?Thickness:float = external {}, ?DrawDurationPolicy:debug_draw_duration_policy = external {}, ?Duration:float = external {})<transacts>:void

            # Draws a cone at the named location, and using the provided draw parameters.
            DrawCone<public>(Origin:(/UnrealEngine.com/Temporary/SpatialMath:)vector3, Direction:(/UnrealEngine.com/Temporary/SpatialMath:)vector3, ?Height:float = external {}, ?NumSides:int = external {}, ?AngleWidthRadians:float = external {}, ?AngleHeightRadians:float = external {}, ?Color:color = external {}, ?Thickness:float = external {}, ?DrawDurationPolicy:debug_draw_duration_policy = external {}, ?Duration:float = external {})<transacts>:void = external {}

            # Draws a cylinder at the named location, and using the provided draw parameters.
            DrawCylinder<native><public>(Start:(/Verse.org/SpatialMath:)vector3, End:(/Verse.org/SpatialMath:)vector3, ?NumSegments:int = external {}, ?Radius:float = external {}, ?Color:color = external {}, ?Thickness:float = external {}, ?DrawDurationPolicy:debug_draw_duration_policy = external {}, ?Duration:float = external {})<transacts>:void

            # Draws a cylinder at the named location, and using the provided draw parameters.
            DrawCylinder<public>(Start:(/UnrealEngine.com/Temporary/SpatialMath:)vector3, End:(/UnrealEngine.com/Temporary/SpatialMath:)vector3, ?NumSegments:int = external {}, ?Radius:float = external {}, ?Color:color = external {}, ?Thickness:float = external {}, ?DrawDurationPolicy:debug_draw_duration_policy = external {}, ?Duration:float = external {})<transacts>:void = external {}

            # Draws a line from Start to End locations, and using the provided draw parameters.
            DrawLine<native><public>(Start:(/Verse.org/SpatialMath:)vector3, End:(/Verse.org/SpatialMath:)vector3, ?Color:color = external {}, ?Thickness:float = external {}, ?DrawDurationPolicy:debug_draw_duration_policy = external {}, ?Duration:float = external {})<transacts>:void

            # Draws a line from Start to End locations, and using the provided draw parameters.
            DrawLine<public>(Start:(/UnrealEngine.com/Temporary/SpatialMath:)vector3, End:(/UnrealEngine.com/Temporary/SpatialMath:)vector3, ?Color:color = external {}, ?Thickness:float = external {}, ?DrawDurationPolicy:debug_draw_duration_policy = external {}, ?Duration:float = external {})<transacts>:void = external {}

            # Draws a point at the named location, and using the provided draw parameters.
            DrawPoint<native><public>(Position:(/Verse.org/SpatialMath:)vector3, ?Color:color = external {}, ?Thickness:float = external {}, ?DrawDurationPolicy:debug_draw_duration_policy = external {}, ?Duration:float = external {})<transacts>:void

            # Draws a point at the named location, and using the provided draw parameters.
            DrawPoint<public>(Position:(/UnrealEngine.com/Temporary/SpatialMath:)vector3, ?Color:color = external {}, ?Thickness:float = external {}, ?DrawDurationPolicy:debug_draw_duration_policy = external {}, ?Duration:float = external {})<transacts>:void = external {}

            # Draws an arrow pointing from Start to End locations, and using the provided draw parameters.
            DrawArrow<native><public>(Start:(/Verse.org/SpatialMath:)vector3, End:(/Verse.org/SpatialMath:)vector3, ?ArrowSize:float = external {}, ?Color:color = external {}, ?Thickness:float = external {}, ?DrawDurationPolicy:debug_draw_duration_policy = external {}, ?Duration:float = external {})<transacts>:void

            # Draws an arrow pointing from Start to End locations, and using the provided draw parameters.
            DrawArrow<public>(Start:(/UnrealEngine.com/Temporary/SpatialMath:)vector3, End:(/UnrealEngine.com/Temporary/SpatialMath:)vector3, ?ArrowSize:float = external {}, ?Color:color = external {}, ?Thickness:float = external {}, ?DrawDurationPolicy:debug_draw_duration_policy = external {}, ?Duration:float = external {})<transacts>:void = external {}

            # Draws a 3D text using the provided draw parameters.
            DrawText<native><public>(Text:string, Position:(/Verse.org/SpatialMath:)vector3, ?Color:color = external {}, ?DrawDurationPolicy:debug_draw_duration_policy = external {}, ?Duration:float = external {}, ?FontScale:float = external {}, ?DrawDropShadow:logic = external {})<transacts>:void

            # Draws a 3D text using the provided draw parameters.
            DrawText<public>(Text:string, Position:(/UnrealEngine.com/Temporary/SpatialMath:)vector3, ?Color:color = external {}, ?DrawDurationPolicy:debug_draw_duration_policy = external {}, ?Duration:float = external {}, ?FontScale:float = external {}, ?DrawDropShadow:logic = external {})<transacts>:void = external {}

        # log levels available for various log commands
        log_level<native><public> := enum:
            Debug
            Verbose
            Normal
            Warning
            Error

        # log_channel is the base class used to define log channels. When printing a message to a log, the log channel class name will be prefixed to the output message.
        log_channel<native><public> := class<abstract>:

        # log class to send messages to the default log
        log<native><public> := class:
            # Channel class name will be added as a prefix used when printing the message e.g. '[log_channel]: #Message
            Channel<native><public>:subtype(log_channel)

            # Sets the default log level of the displayed message. See log_level enum for more info on log levels. Defaults to log_level.Normal.
            DefaultLevel<native><public>:log_level = external {}

            # Print `Message` using the given log level.
            (/UnrealEngine.com/Temporary/Diagnostics/log:)Print<public>(Message:string, ?Level:log_level = external {})<computes>:void = external {}

            # Print `Message` diagnostic using the given log level.
            (/UnrealEngine.com/Temporary/Diagnostics/log:)Print<public>(Message:diagnostic, ?Level:log_level = external {})<computes>:void = external {}

            # Prints the current script call stack using the given log level.
            PrintCallStack<native><public>(?Level:log_level = external {})<computes>:void

    # Module import path: /UnrealEngine.com/Temporary/SpatialMath
    (/UnrealEngine.com/Temporary:)SpatialMath<public> := module:
        using {/Verse.org/SpatialMath}
        using {/Verse.org/Native}
        using {/Verse.org/Simulation}
        @editable
        @import_as("/Script/EpicGamesTemporary.FVerseRotation_Deprecated")
        # An abstract representation of an orientation change in 3d-space.
        (/UnrealEngine.com/Temporary/SpatialMath:)rotation<native><public> := struct<concrete>:

        @vm_no_effect_token
        # Makes a `rotation` from `Axis` and `AngleRadians` using a left-handed sign convention (e.g. a positive rotation around +Z takes +X to +Y). If `Axis.IsAlmostZero[]`, make the identity rotation.
        MakeRotation<native><public>(Axis:(/UnrealEngine.com/Temporary/SpatialMath:)vector3, AngleRadians:float)<reads><converges>:(/UnrealEngine.com/Temporary/SpatialMath:)rotation

        @vm_no_effect_token
        # Makes a `rotation` by applying `YawRightDegrees`, `PitchUpDegrees`, and `RollClockwiseDegrees`, in that order:
        #  * first a *yaw* about the Z axis with a positive angle indicating a clockwise rotation when viewed from above,
        #  * then a *pitch* about the new Y axis with a positive angle indicating 'nose up',
        #  * followed by a *roll* about the new X axis axis with a positive angle indicating a clockwise rotation when viewed along +X.
        # Note that these conventions differ from `MakeRotation` but match `ApplyYaw`, `ApplyPitch`, and `ApplyRoll`.
        (/UnrealEngine.com/Temporary/SpatialMath:)MakeRotationFromYawPitchRollDegrees<native><public>(YawRightDegrees:float, PitchUpDegrees:float, RollClockwiseDegrees:float)<reads><converges>:(/UnrealEngine.com/Temporary/SpatialMath:)rotation

        # Makes the identity `rotation`.
        (/UnrealEngine.com/Temporary/SpatialMath:)IdentityRotation<native><public>()<converges>:(/UnrealEngine.com/Temporary/SpatialMath:)rotation

        @vm_no_effect_token
        # Returns the 'distance' between `Rotation1` and `Rotation2`. The result will be between:
        #  * `0.0`, representing equivalent rotations and
        #  * `1.0` representing rotations which are 180 degrees apart (i.e., the shortest rotation between them is 180 degrees around some axis).
        (/UnrealEngine.com/Temporary/SpatialMath:)Distance<native><public>(Rotation1:(/UnrealEngine.com/Temporary/SpatialMath:)rotation, Rotation2:(/UnrealEngine.com/Temporary/SpatialMath:)rotation)<reads>:float

        @vm_no_effect_token
        # Returns the 'smallest angular distance' between `Rotation1` and `Rotation2` in radians.
        AngularDistance<native><public>(Rotation1:(/UnrealEngine.com/Temporary/SpatialMath:)rotation, Rotation2:(/UnrealEngine.com/Temporary/SpatialMath:)rotation)<reads>:float

        # Makes a `rotation` by applying `PitchUpRadians` of right-handed rotation around the local +Y axis to `InitialRotation`.
        (InitialRotation:(/UnrealEngine.com/Temporary/SpatialMath:)rotation).ApplyPitch<native><public>(PitchUpRadians:float)<transacts>:(/UnrealEngine.com/Temporary/SpatialMath:)rotation

        # Makes a `rotation` by applying `RollClockwiseRadians` of right-handed rotation around the local +X axis to `InitialRotation`.
        (InitialRotation:(/UnrealEngine.com/Temporary/SpatialMath:)rotation).ApplyRoll<native><public>(RollClockwiseRadians:float)<transacts>:(/UnrealEngine.com/Temporary/SpatialMath:)rotation

        # Makes a `rotation` by applying `YawRightRadians` of left-handed rotation around the local +Z axis to `InitialRotation`.
        (InitialRotation:(/UnrealEngine.com/Temporary/SpatialMath:)rotation).ApplyYaw<native><public>(YawRightRadians:float)<transacts>:(/UnrealEngine.com/Temporary/SpatialMath:)rotation

        # Makes a `rotation` by applying `AngleRadians` of left-handed rotation around the world +X axis to `InitialRotation`.
        (InitialRotation:(/UnrealEngine.com/Temporary/SpatialMath:)rotation).ApplyWorldRotationX<native><public>(AngleRadians:float)<transacts>:(/UnrealEngine.com/Temporary/SpatialMath:)rotation

        # Makes a `rotation` by applying `AngleRadians` of left-handed rotation around the world +Y axis to `InitialRotation`.
        (InitialRotation:(/UnrealEngine.com/Temporary/SpatialMath:)rotation).ApplyWorldRotationY<native><public>(AngleRadians:float)<transacts>:(/UnrealEngine.com/Temporary/SpatialMath:)rotation

        # Makes a `rotation` by applying `AngleRadians` of left-handed rotation around the world +Z axis to `InitialRotation`.
        (InitialRotation:(/UnrealEngine.com/Temporary/SpatialMath:)rotation).ApplyWorldRotationZ<native><public>(AngleRadians:float)<transacts>:(/UnrealEngine.com/Temporary/SpatialMath:)rotation

        # Makes a `rotation` by applying `AngleRadians` of left-handed rotation around the local +Y axis to `InitialRotation`.
        (InitialRotation:(/UnrealEngine.com/Temporary/SpatialMath:)rotation).ApplyLocalRotationY<public>(AngleRadians:float)<transacts>:(/UnrealEngine.com/Temporary/SpatialMath:)rotation = external {}

        # Makes a `rotation` by applying `AngleRadians` of left-handed rotation around the local +Z axis to `InitialRotation`.
        (InitialRotation:(/UnrealEngine.com/Temporary/SpatialMath:)rotation).ApplyLocalRotationZ<public>(AngleRadians:float)<transacts>:(/UnrealEngine.com/Temporary/SpatialMath:)rotation = external {}

        # Makes a `rotation` by composing `AdditionalRotation` to `InitialRotation`.
        (InitialRotation:(/UnrealEngine.com/Temporary/SpatialMath:)rotation).RotateBy<native><public>(AdditionalRotation:(/UnrealEngine.com/Temporary/SpatialMath:)rotation)<transacts>:(/UnrealEngine.com/Temporary/SpatialMath:)rotation

        # Makes a `rotation` by composing the inverse of `RotationToRemove` from `InitialRotation`. such that InitialRotation = RotateBy(UnrotateBy(InitialRotation, RotationToRemove), RotationToRemove). This is equivalent to RotateBy(InitialRotation, InvertRotation(RotationToRemove))
        (InitialRotation:(/UnrealEngine.com/Temporary/SpatialMath:)rotation).UnrotateBy<native><public>(RotationToRemove:(/UnrealEngine.com/Temporary/SpatialMath:)rotation)<transacts>:(/UnrealEngine.com/Temporary/SpatialMath:)rotation

        @vm_no_effect_token
        # Makes an `[]float` with three elements:
        #  * *yaw* degrees of `rotation`
        #  * *pitch* degrees of `rotation`
        #  * *roll* degrees of `rotation`
        # using the conventions of `MakeRotationFromYawPitchRollDegrees`.
        (Rotation:(/UnrealEngine.com/Temporary/SpatialMath:)rotation).(/UnrealEngine.com/Temporary/SpatialMath:)GetYawPitchRollDegrees<native><public>()<reads>:[]float

        @vm_no_effect_token
        # Makes a `vector3` from the axis of `rotation`.
        # If `rotation` is nearly identity, this will return the +X axis. See also `GetAngle`.
        (Rotation:(/UnrealEngine.com/Temporary/SpatialMath:)rotation).(/UnrealEngine.com/Temporary/SpatialMath:)GetAxis<native><public>()<reads>:(/UnrealEngine.com/Temporary/SpatialMath:)vector3

        @vm_no_effect_token
        # Returns the radians of `rotation` around the axis of `rotation`. See also `GetAxis`.
        (Rotation:(/UnrealEngine.com/Temporary/SpatialMath:)rotation).GetAngle<native><public>()<reads>:float

        # Makes the smallest angular `rotation` from `InitialRotation` to `FinalRotation` such that:
        # `InitialRotation.RotateBy(MakeShortestRotationBetween(InitialRotation, FinalRotation)) = FinalRotation` and
        # `MakeShortestRotationBetween(InitialRotation, FinalRotation)?.GetAngle()` is as small as possible.
        (/UnrealEngine.com/Temporary/SpatialMath:)MakeShortestRotationBetween<native><public>(InitialRotation:(/UnrealEngine.com/Temporary/SpatialMath:)rotation, FinalRotation:(/UnrealEngine.com/Temporary/SpatialMath:)rotation)<transacts>:(/UnrealEngine.com/Temporary/SpatialMath:)rotation

        # Makes the smallest angular `rotation` from `InitialVector` to `FinalVector` such that:
        # `InitialVector.RotateBy(MakeShortestRotationBetween(InitialVector, Vector)) = FinalVector` and
        # `MakeShortestRotationBetween(InitialVector, FinalVector)?.GetAngle()` is as small as possible.
        (/UnrealEngine.com/Temporary/SpatialMath:)MakeShortestRotationBetween<native><public>(InitialVector:(/UnrealEngine.com/Temporary/SpatialMath:)vector3, FinalVector:(/UnrealEngine.com/Temporary/SpatialMath:)vector3)<transacts>:(/UnrealEngine.com/Temporary/SpatialMath:)rotation

        # Makes a new `rotation` from the component wise subtraction of the Euler angle components in `RotationA` by 
        # the Euler angle components in `RotationB` and ensures the returned value is normalized.
        MakeComponentWiseDeltaRotation<native><public>(RotationA:(/UnrealEngine.com/Temporary/SpatialMath:)rotation, RotationB:(/UnrealEngine.com/Temporary/SpatialMath:)rotation)<transacts>:(/UnrealEngine.com/Temporary/SpatialMath:)rotation

        # Used to perform spherical linear interpolation between `From` (when `Parameter = 0.0`) and `To` (when `Parameter = 1.0`). Expects that `0.0 <= Parameter <= 1.0`.
        (/UnrealEngine.com/Temporary/SpatialMath:)Slerp<native><public>(InitialRotation:(/UnrealEngine.com/Temporary/SpatialMath:)rotation, FinalRotation:(/UnrealEngine.com/Temporary/SpatialMath:)rotation, Parameter:float)<transacts><decides>:(/UnrealEngine.com/Temporary/SpatialMath:)rotation

        @vm_no_effect_token
        # Makes a `vector3` by applying `Rotation` to `Vector`.
        (Rotation:(/UnrealEngine.com/Temporary/SpatialMath:)rotation).RotateVector<native><public>(Vector:(/UnrealEngine.com/Temporary/SpatialMath:)vector3)<reads>:(/UnrealEngine.com/Temporary/SpatialMath:)vector3

        @vm_no_effect_token
        # Makes a `vector3` by applying the inverse of `Rotation` to `Vector`.
        (Rotation:(/UnrealEngine.com/Temporary/SpatialMath:)rotation).UnrotateVector<native><public>(Vector:(/UnrealEngine.com/Temporary/SpatialMath:)vector3)<reads>:(/UnrealEngine.com/Temporary/SpatialMath:)vector3

        # Makes a `rotation` by inverting `Rotation` such that `ApplyRotation(Rotation, Rotation.Invert())) = IdentityRotation`.
        (Rotation:(/UnrealEngine.com/Temporary/SpatialMath:)rotation).(/UnrealEngine.com/Temporary/SpatialMath:)Invert<native><public>()<transacts>:(/UnrealEngine.com/Temporary/SpatialMath:)rotation

        # Returns `Rotation` if it does not contain `NaN`, `Inf` or `-Inf`.
        (Rotation:(/UnrealEngine.com/Temporary/SpatialMath:)rotation).(/UnrealEngine.com/Temporary/SpatialMath:)IsFinite<native><public>()<decides><converges>:(/UnrealEngine.com/Temporary/SpatialMath:)rotation

        # Makes a unit `vector3` pointing in the local space *forward* direction in world space coordinates.
        # This is equivalent to: `RotateVector(Rotation, vector3{X:=1.0, Y:=0.0, Z:=0.0})`.
        (Rotation:(/UnrealEngine.com/Temporary/SpatialMath:)rotation).GetLocalForward<public>()<transacts>:(/UnrealEngine.com/Temporary/SpatialMath:)vector3 = external {}

        # Makes a unit `vector3` pointing in the the local space *right* direction in world space coordinates.
        # This is equivalent to: `RotateVector(Rotation, vector3{X:=0.0, Y:=1.0, Z:=0.0})`.
        (Rotation:(/UnrealEngine.com/Temporary/SpatialMath:)rotation).GetLocalRight<public>()<transacts>:(/UnrealEngine.com/Temporary/SpatialMath:)vector3 = external {}

        # Makes a unit `vector3` pointing in the local space *up* direction in world space coordinates.
        # This is equivalent to: `RotateVector(Rotation, vector3{X:=0.0, Y:=0.0, Z:=1.0})`.
        (Rotation:(/UnrealEngine.com/Temporary/SpatialMath:)rotation).GetLocalUp<public>()<transacts>:(/UnrealEngine.com/Temporary/SpatialMath:)vector3 = external {}

        # Makes a `string` representation of `rotation` in axis/degrees format with a left-handed sign convention.
        # `ToString(MakeRotation(vector3{X:=1.0, Y:=0.0, Z:=0.0}, PiFloat/2.0))` produces the string: `"Axis: {x=1.000000,y=0.000000,z=0.000000} Angle: 90.000000"`.
        (/UnrealEngine.com/Temporary/SpatialMath:)ToString<public>(Rotation:(/UnrealEngine.com/Temporary/SpatialMath:)rotation)<reads>:string = external {}

        # Returns radians from `Degrees`.
        (/UnrealEngine.com/Temporary/SpatialMath:)DegreesToRadians<public>(Degrees:float)<reads>:float = external {}

        # Returns degrees from `Radians`.
        (/UnrealEngine.com/Temporary/SpatialMath:)RadiansToDegrees<public>(Radians:float)<reads>:float = external {}

        @available {MinUploadedAtFNVersion := 3400}
        # Util function for converting a translation/position `vector3` from /UnrealEngine.com/Temporary/SpatialMath to a `vector3` from /Verse.org/SpatialMath.
        FromVector3<public>(InVector3:(/UnrealEngine.com/Temporary/SpatialMath:)vector3)<reads>:(/Verse.org/SpatialMath:)vector3 = external {}

        @available {MinUploadedAtFNVersion := 3600}
        # Util function for converting a scalar `vector3` from /UnrealEngine.com/Temporary/SpatialMath to a `vector3` from /Verse.org/SpatialMath.
        # Use this function when your vector indicates a magnitude on each axis but not a direction, such as when you convert a scale measurement rather than a translation or position.
        FromScalarVector3<public>(InVector3:(/UnrealEngine.com/Temporary/SpatialMath:)vector3)<reads>:(/Verse.org/SpatialMath:)vector3 = external {}

        @available {MinUploadedAtFNVersion := 3400}
        # Util function for converting a `rotation` from /UnrealEngine.com/Temporary/SpatialMath to a `rotation` from /Verse.org/SpatialMath.
        FromRotation<public>(InRotation:(/UnrealEngine.com/Temporary/SpatialMath:)rotation)<reads>:(/Verse.org/SpatialMath:)rotation = external {}

        @available {MinUploadedAtFNVersion := 3400}
        # Util function for converting a `transform` from /UnrealEngine.com/Temporary/SpatialMath to a `transform` from /Verse.org/SpatialMath.
        FromTransform<public>(InTransform:(/UnrealEngine.com/Temporary/SpatialMath:)transform)<reads>:(/Verse.org/SpatialMath:)transform = external {}

        @available {MinUploadedAtFNVersion := 3400}
        # Util function for converting a translation/position `vector3` from /Verse.org/SpatialMath to a `vector3` from /UnrealEngine.com/Temporary/SpatialMath.
        FromVector3<public>(InVector3:(/Verse.org/SpatialMath:)vector3)<reads>:(/UnrealEngine.com/Temporary/SpatialMath:)vector3 = external {}

        @available {MinUploadedAtFNVersion := 3600}
        # Util function for converting a scalar `vector3` from /Verse.org/SpatialMath to a `vector3` from /UnrealEngine.com/Temporary/SpatialMath.
        # Use this function when your vector indicates a magnitude on each axis but not a direction, such as when you convert a scale measurement rather than a translation or position.
        FromScalarVector3<public>(InVector3:(/Verse.org/SpatialMath:)vector3)<reads>:(/UnrealEngine.com/Temporary/SpatialMath:)vector3 = external {}

        @available {MinUploadedAtFNVersion := 3400}
        # Util function for converting a `rotation` from /Verse.org/SpatialMath to a `rotation` from /UnrealEngine.com/Temporary/SpatialMath.
        FromRotation<public>(InRotation:(/Verse.org/SpatialMath:)rotation)<reads>:(/UnrealEngine.com/Temporary/SpatialMath:)rotation = external {}

        @available {MinUploadedAtFNVersion := 3400}
        # Util function for converting a `transform` from /Verse.org/SpatialMath to a `transform` from /UnrealEngine.com/Temporary/SpatialMath.
        FromTransform<public>(InTransform:(/Verse.org/SpatialMath:)transform)<reads>:(/UnrealEngine.com/Temporary/SpatialMath:)transform = external {}

        # A combination of scale, rotation, and translation, applied in that order.
        (/UnrealEngine.com/Temporary/SpatialMath:)transform<native><public> := struct<concrete><computes>:
            @editable
            # The scale of this `transform`.
            Scale<native><public>:(/UnrealEngine.com/Temporary/SpatialMath:)vector3 = external {}

            @editable
            # The rotation of this `transform`.
            Rotation<native><public>:(/UnrealEngine.com/Temporary/SpatialMath:)rotation = external {}

            @editable
            # The location of this `transform`.
            Translation<native><public>:(/UnrealEngine.com/Temporary/SpatialMath:)vector3 = external {}

        # Makes a `vector3` by applying `InTransform` to `InVector`.
        TransformVector<public>(InTransform:(/UnrealEngine.com/Temporary/SpatialMath:)transform, InVector:(/UnrealEngine.com/Temporary/SpatialMath:)vector3)<reads>:(/UnrealEngine.com/Temporary/SpatialMath:)vector3 = external {}

        # Makes a `vector3` by applying `InTransform` to `InVector` without applying `InTransform.Scale`.
        TransformVectorNoScale<public>(InTransform:(/UnrealEngine.com/Temporary/SpatialMath:)transform, InVector:(/UnrealEngine.com/Temporary/SpatialMath:)vector3)<reads>:(/UnrealEngine.com/Temporary/SpatialMath:)vector3 = external {}

        # 2-dimensional vector with `float` components.
        vector2<native><public> := struct<concrete><computes><persistable>:
            @editable
            X<native><public>:float = external {}

            @editable
            Y<native><public>:float = external {}

        # Makes a `vector2` by inverting the `SurfaceNormal` component of `Direction`.
        # Fails if `not SurfaceNormal.MakeUnitVector[]`.
        (/UnrealEngine.com/Temporary/SpatialMath:)ReflectVector<public>(Direction:vector2, SurfaceNormal:vector2)<reads><decides>:vector2 = external {}

        # Returns the dot product of `V1` and `V2`.
        (/UnrealEngine.com/Temporary/SpatialMath:)DotProduct<public>(V1:vector2, V2:vector2)<reads>:float = external {}

        # Returns the Euclidean distance between `V1` and `V2`.
        (/UnrealEngine.com/Temporary/SpatialMath:)Distance<public>(V1:vector2, V2:vector2)<reads>:float = external {}

        # Returns the squared Euclidean distance between `V1` and `V2`.
        (/UnrealEngine.com/Temporary/SpatialMath:)DistanceSquared<public>(V1:vector2, V2:vector2)<reads>:float = external {}

        # Makes a unit length `vector2` pointing in the same direction of `V`.
        # Fails if `V.IsAlmostZero[] or not V.IsFinite[]`.
        (V:vector2).(/UnrealEngine.com/Temporary/SpatialMath:)MakeUnitVector<public>()<reads><decides>:vector2 = external {}

        # Returns the length of `V`.
        (V:vector2).(/UnrealEngine.com/Temporary/SpatialMath:)Length<public>()<reads>:float = external {}

        # Returns the squared length of `V`.
        (V:vector2).(/UnrealEngine.com/Temporary/SpatialMath:)LengthSquared<public>()<reads>:float = external {}

        # Used to linearly interpolate/extrapolate between `From` (when `Parameter = 0.0`) and `To` (when `Parameter = 1.0`). Expects that all arguments are finite.
        # Returns `From*(1 - Parameter) + To*Parameter`.
        (/UnrealEngine.com/Temporary/SpatialMath:)Lerp<public>(From:vector2, To:vector2, Parameter:float)<reads>:vector2 = external {}

        # Makes a `string` representation of `V`.
        (/UnrealEngine.com/Temporary/SpatialMath:)ToString<public>(V:vector2)<reads>:string = external {}

        # Makes a `vector2` by inverting the signs of `Operand`.
        (/UnrealEngine.com/Temporary/SpatialMath:)prefix'-'<public>(Operand:vector2)<computes>:vector2 = external {}

        # Makes a `vector2` by component-wise addition of `Left` and `Right`.
        (/UnrealEngine.com/Temporary/SpatialMath:)operator'+'<public>(Left:vector2, Right:vector2)<computes>:vector2 = external {}

        # Makes a `vector2` by component-wise subtraction of `Right` from `Left`.
        (/UnrealEngine.com/Temporary/SpatialMath:)operator'-'<public>(Left:vector2, Right:vector2)<computes>:vector2 = external {}

        # Makes a `vector2` by component-wise multiplication of `Left` and `Right`.
        (/UnrealEngine.com/Temporary/SpatialMath:)operator'*'<public>(Left:vector2, Right:float)<computes>:vector2 = external {}

        # Makes a `vector2` by multiplying the components of `Right` by `Left`.
        (/UnrealEngine.com/Temporary/SpatialMath:)operator'*'<public>(Left:float, Right:vector2)<computes>:vector2 = external {}

        # Makes a `vector2` by dividing the components of `Left` by `Right`.
        (/UnrealEngine.com/Temporary/SpatialMath:)operator'/'<public>(Left:vector2, Right:float)<computes>:vector2 = external {}

        # Makes a `vector2` by component-wise division of `Left` by `Right`.
        (/UnrealEngine.com/Temporary/SpatialMath:)operator'/'<public>(Left:vector2, Right:vector2)<computes>:vector2 = external {}

        # Makes a `vector2` by converting the components of `V` to `float`s.
        ToVector2<public>(V:vector2i)<transacts>:vector2 = external {}

        # Returns `V` if all components are finite.
        # Fails if any of the components are not finite.
        (V:vector2).(/UnrealEngine.com/Temporary/SpatialMath:)IsFinite<public>()<computes><decides>:vector2 = external {}

        # Succeeds when each component of `V` is within `AbsoluteTolerance` of `0.0`.
        (V:vector2).(/UnrealEngine.com/Temporary/SpatialMath:)IsAlmostZero<public>(AbsoluteTolerance:float)<computes><decides>:void = external {}

        # Succeeds when each component of `V1` and `V2` are within `AbsoluteTolerance` of each other.
        (/UnrealEngine.com/Temporary/SpatialMath:)IsAlmostEqual<public>(V1:vector2, V2:vector2, AbsoluteTolerance:float)<computes><decides>:void = external {}

        # 2-dimensional vector with `int` components.
        vector2i<native><public> := struct<concrete><computes><persistable>:
            @editable
            X<native><public>:int = external {}

            @editable
            Y<native><public>:int = external {}

        # Returns the dot product of `V1` and `V2`.
        (/UnrealEngine.com/Temporary/SpatialMath:)DotProduct<public>(V1:vector2i, V2:vector2i)<computes>:int = external {}

        # Makes a `vector2i` that is component-wise equal to `V1` and `V2`.
        # Fails if any component of `V1` does not equal the corresponding component of `V2`.
        Equals<public>(V1:vector2i, V2:vector2i)<computes><decides>:vector2i = external {}

        # Makes a `string` representation of `V`.
        (/UnrealEngine.com/Temporary/SpatialMath:)ToString<public>(V:vector2i)<computes>:string = external {}

        # Makes a `vector2i` by component-wise truncation of `V` to `ints`s.
        ToVector2i<public>(V:vector2)<reads><decides>:vector2i = external {}

        # Makes a `vector2i` by inverting the signs of `Operand`.
        (/UnrealEngine.com/Temporary/SpatialMath:)prefix'-'<public>(Operand:vector2i)<computes>:vector2i = external {}

        # Makes a `vector2i` by component-wise addition of `Left` and `Right`.
        (/UnrealEngine.com/Temporary/SpatialMath:)operator'+'<public>(Left:vector2i, Right:vector2i)<computes>:vector2i = external {}

        # Makes a `vector2i` by component-wise subtraction of `Right` from `Left`.
        (/UnrealEngine.com/Temporary/SpatialMath:)operator'-'<public>(Left:vector2i, Right:vector2i)<computes>:vector2i = external {}

        # Makes a `vector2i` by multiplying the components of `Left` by `Right`.
        (/UnrealEngine.com/Temporary/SpatialMath:)operator'*'<public>(Left:vector2i, Right:int)<computes>:vector2i = external {}

        # Makes a `vector2i` by multiplying the components of `Right` by `Left`.
        (/UnrealEngine.com/Temporary/SpatialMath:)operator'*'<public>(Left:int, Right:vector2i)<computes>:vector2i = external {}

        # 3-dimensional vector with `float` components.
        (/UnrealEngine.com/Temporary/SpatialMath:)vector3<native><public> := struct<concrete><computes><persistable>:
            @editable
            X<native><public>:float = external {}

            @editable
            Y<native><public>:float = external {}

            @editable
            Z<native><public>:float = external {}

        # Makes a `vector3` by inverting the `SurfaceNormal` component of `Direction`.
        # Fails if `not SurfaceNormal.MakeUnitVector[]`.
        (/UnrealEngine.com/Temporary/SpatialMath:)ReflectVector<public>(Direction:(/UnrealEngine.com/Temporary/SpatialMath:)vector3, SurfaceNormal:(/UnrealEngine.com/Temporary/SpatialMath:)vector3)<reads><decides>:(/UnrealEngine.com/Temporary/SpatialMath:)vector3 = external {}

        # Returns the dot product of `V1` and `V2`.
        (/UnrealEngine.com/Temporary/SpatialMath:)DotProduct<public>(V1:(/UnrealEngine.com/Temporary/SpatialMath:)vector3, V2:(/UnrealEngine.com/Temporary/SpatialMath:)vector3)<reads>:float = external {}

        # Returns the cross product of `V1` and `V2`.
        (/UnrealEngine.com/Temporary/SpatialMath:)CrossProduct<public>(V1:(/UnrealEngine.com/Temporary/SpatialMath:)vector3, V2:(/UnrealEngine.com/Temporary/SpatialMath:)vector3)<reads>:(/UnrealEngine.com/Temporary/SpatialMath:)vector3 = external {}

        # Returns the Euclidean distance between `V1` and `V2`.
        (/UnrealEngine.com/Temporary/SpatialMath:)Distance<public>(V1:(/UnrealEngine.com/Temporary/SpatialMath:)vector3, V2:(/UnrealEngine.com/Temporary/SpatialMath:)vector3)<reads>:float = external {}

        # Returns the squared Euclidean distance between `V1` and `V2`.
        (/UnrealEngine.com/Temporary/SpatialMath:)DistanceSquared<public>(V1:(/UnrealEngine.com/Temporary/SpatialMath:)vector3, V2:(/UnrealEngine.com/Temporary/SpatialMath:)vector3)<reads>:float = external {}

        # Returns the 2-D Euclidean distance between `V1` and `V2` by ignoring the difference in `Z`.
        DistanceXY<public>(V1:(/UnrealEngine.com/Temporary/SpatialMath:)vector3, V2:(/UnrealEngine.com/Temporary/SpatialMath:)vector3)<reads>:float = external {}

        # Returns the squared 2-D Euclidean distance between `V1` and `V2` by ignoring their difference in `Z`.
        DistanceSquaredXY<public>(V1:(/UnrealEngine.com/Temporary/SpatialMath:)vector3, V2:(/UnrealEngine.com/Temporary/SpatialMath:)vector3)<reads>:float = external {}

        # Makes a unit length `vector3` pointing in the same direction of `V`.
        # Fails if `V.IsAlmostZero[] or not V.IsFinite[]`.
        (V:(/UnrealEngine.com/Temporary/SpatialMath:)vector3).(/UnrealEngine.com/Temporary/SpatialMath:)MakeUnitVector<public>()<reads><decides>:(/UnrealEngine.com/Temporary/SpatialMath:)vector3 = external {}

        # Makes a `string` representation of `V`.
        (/UnrealEngine.com/Temporary/SpatialMath:)ToString<public>(V:(/UnrealEngine.com/Temporary/SpatialMath:)vector3)<reads>:string = external {}

        # Returns the length of `V`.
        (V:(/UnrealEngine.com/Temporary/SpatialMath:)vector3).(/UnrealEngine.com/Temporary/SpatialMath:)Length<public>()<reads>:float = external {}

        # Returns the squared length of `V`.
        (V:(/UnrealEngine.com/Temporary/SpatialMath:)vector3).(/UnrealEngine.com/Temporary/SpatialMath:)LengthSquared<public>()<computes>:float = external {}

        # Returns the length of `V` as if `V.Z = 0.0`.
        (V:(/UnrealEngine.com/Temporary/SpatialMath:)vector3).LengthXY<public>()<reads>:float = external {}

        # Returns the squared length of `V` as if `V.Z = 0.0`.
        (V:(/UnrealEngine.com/Temporary/SpatialMath:)vector3).LengthSquaredXY<public>()<reads>:float = external {}

        # Used to linearly interpolate/extrapolate between `From` (when `Parameter = 0.0`) and `To` (when `Parameter = 1.0`). Expects that all arguments are finite.
        # Returns `From*(1 - Parameter) + To*Parameter`.
        (/UnrealEngine.com/Temporary/SpatialMath:)Lerp<public>(From:(/UnrealEngine.com/Temporary/SpatialMath:)vector3, To:(/UnrealEngine.com/Temporary/SpatialMath:)vector3, Parameter:float)<reads>:(/UnrealEngine.com/Temporary/SpatialMath:)vector3 = external {}

        # Makes a `vector3` by inverting the signs of `Operand`.
        (/UnrealEngine.com/Temporary/SpatialMath:)prefix'-'<public>(Operand:(/UnrealEngine.com/Temporary/SpatialMath:)vector3)<computes>:(/UnrealEngine.com/Temporary/SpatialMath:)vector3 = external {}

        # Makes a `vector3` by component-wise addition of `L` and `R`.
        (/UnrealEngine.com/Temporary/SpatialMath:)operator'+'<public>(L:(/UnrealEngine.com/Temporary/SpatialMath:)vector3, R:(/UnrealEngine.com/Temporary/SpatialMath:)vector3)<computes>:(/UnrealEngine.com/Temporary/SpatialMath:)vector3 = external {}

        # Makes a `vector3` by component-wise subtraction of `R` from `L`.
        (/UnrealEngine.com/Temporary/SpatialMath:)operator'-'<public>(L:(/UnrealEngine.com/Temporary/SpatialMath:)vector3, R:(/UnrealEngine.com/Temporary/SpatialMath:)vector3)<computes>:(/UnrealEngine.com/Temporary/SpatialMath:)vector3 = external {}

        # Makes a `vector3` by component-wise multiplication of `L` and `R`.
        (/UnrealEngine.com/Temporary/SpatialMath:)operator'*'<public>(L:(/UnrealEngine.com/Temporary/SpatialMath:)vector3, R:(/UnrealEngine.com/Temporary/SpatialMath:)vector3)<computes>:(/UnrealEngine.com/Temporary/SpatialMath:)vector3 = external {}

        # Makes a `vector3` by multiplying the components of `L` by `R`.
        (/UnrealEngine.com/Temporary/SpatialMath:)operator'*'<public>(L:(/UnrealEngine.com/Temporary/SpatialMath:)vector3, R:float)<computes>:(/UnrealEngine.com/Temporary/SpatialMath:)vector3 = external {}

        # Makes a `vector3` by multiplying the components of `R` by `L`.
        (/UnrealEngine.com/Temporary/SpatialMath:)operator'*'<public>(L:float, R:(/UnrealEngine.com/Temporary/SpatialMath:)vector3)<computes>:(/UnrealEngine.com/Temporary/SpatialMath:)vector3 = external {}

        # Makes a `vector3` by dividing the components of `L` by `R`.
        (/UnrealEngine.com/Temporary/SpatialMath:)operator'/'<public>(L:(/UnrealEngine.com/Temporary/SpatialMath:)vector3, R:float)<computes>:(/UnrealEngine.com/Temporary/SpatialMath:)vector3 = external {}

        # Makes a `vector3` by component-wise division of `L` by `R`.
        (/UnrealEngine.com/Temporary/SpatialMath:)operator'/'<public>(L:(/UnrealEngine.com/Temporary/SpatialMath:)vector3, R:(/UnrealEngine.com/Temporary/SpatialMath:)vector3)<computes>:(/UnrealEngine.com/Temporary/SpatialMath:)vector3 = external {}

        # Returns `V` if all components are finite.
        # Fails if any of the components are not finite.
        (V:(/UnrealEngine.com/Temporary/SpatialMath:)vector3).(/UnrealEngine.com/Temporary/SpatialMath:)IsFinite<public>()<computes><decides>:(/UnrealEngine.com/Temporary/SpatialMath:)vector3 = external {}

        # Succeeds when each component of `V` is within `AbsoluteTolerance` of `0.0`.
        (V:(/UnrealEngine.com/Temporary/SpatialMath:)vector3).(/UnrealEngine.com/Temporary/SpatialMath:)IsAlmostZero<public>(AbsoluteTolerance:float)<computes><decides>:void = external {}

        # Succeeds when each component of `V1` and `V2` are within `AbsoluteTolerance` of each other.
        (/UnrealEngine.com/Temporary/SpatialMath:)IsAlmostEqual<public>(V1:(/UnrealEngine.com/Temporary/SpatialMath:)vector3, V2:(/UnrealEngine.com/Temporary/SpatialMath:)vector3, AbsoluteTolerance:float)<computes><decides>:void = external {}

    # Stably sort `Array` using `Less` where `Less` succeeding indicates `Left` should precede `Right`
    SortBy<native><public>((Array:[]t, Less:type {_(:t, :t)<computes><decides>:void}) where t:type)<computes>:[]t

JSON<public> := module:
    value<native><public> := class:
        # Retrieve an object value or fail if value is not a json object
        AsObject<native><public>()<transacts><decides>:[string]value

        # Retrieve an array value or fail if value is not a json array
        AsArray<native><public>()<transacts><decides>:[]value

        # Retrieve an integer value or fail if value is not a json number
        AsInt<native><public>()<transacts><decides>:int

        # Retrieve a float value or fail if value is not a json number
        AsFloat<native><public>()<transacts><decides>:float

        # Retrieve an object value or fail if value is not a string
        AsString<native><public>()<transacts><decides>:string

        # Retrieve an object value or fail if value is not null
        AsNull<native><public>()<transacts><decides>:void

    # Parse a JSON string returning a value with its contents
    Parse<native><public>(JSONString:string)<transacts><decides>:value

# Module import path: /UnrealEngine.com/ControlInput
ControlInput<public> := module:
    using {/Verse.org/Assets}
    using {/Verse.org/Native}
    using {/Verse.org/Simulation}
    @available {MinUploadedAtFNVersion := 3630}
    # Input_events is a container for user input events which can be subscribed to.
    #   * Use the 'GetPlayerInput' and 'GetInputEvents' functions to retrieve an input_events object for a given player.
    #   * Low-level notifications of current user input: DetectionBeginEvent, DetectionOngoingEvent, and DetectionEndEvent.
    #   * High-level notifications of triggered events: ActivationTriggeredEvent and ActivationCanceledEvent.
    # 
    #                         /—----------<-------\ 
    #  DetectionBeginEvent -> DetectionOngoingEvent -> ActivationTriggeredEvent -> DetectionEndEvent 
    #            /\                         /\                                            / 
    #              \---------------------> ActivationCanceledEvent ----------------------/
    (/UnrealEngine.com/ControlInput:)input_events<native><public>(t:type) := class:
        # This input has met all required conditions and has successfully fired. Most of the time, you should bind to this event.
        #  Tuple payload: 0: the player generating this event
        #                 1: the value generated by the physical input
        ActivationTriggeredEvent<native><public>:listenable(tuple(player, t)) = external {}

        # This input has been canceled before activation. For example, if the key is released before a “Press and Hold” time threshold.
        #  Tuple payload: 0: the player generating this event
        #                 1: the value generated by the physical input
        #                 2: elapsed seconds since detection began
        ActivationCanceledEvent<native><public>:listenable(tuple(player, t, float)) = external {}

        # Detection has started for this input e.g. a required key is now held down. Note: ActivationTriggeredEvent may also occur this frame,
        #  but this event will always be fired first. DetectionBegin and DetectionEnd will always fire, regardless of whether the input is
        #  successful or canceled.
        #  Tuple payload: 0: the player generating this event
        #                 1: the value generated by the physical input
        DetectionBeginEvent<native><public>:listenable(tuple(player, t)) = external {}

        # Detection for this input is still being processed. For example, a time threshold may not be met.
        #  Tuple payload: 0: the player generating this event
        #                 1: the value generated by the physical input
        #                 2: elapsed seconds since detection began
        DetectionOngoingEvent<native><public>:listenable(tuple(player, t, float)) = external {}

        # Detection has finished e.g. no required keys are now down. Will always fire as a pair with DetectionBegin.
        #  Tuple payload: 0: the player generating this event
        #                 1: elapsed seconds since detection began
        DetectionEndEvent<native><public>:listenable(tuple(player, float)) = external {}

    @available {MinUploadedAtFNVersion := 3630}
    # Access input-related data and settings for a player.
    (/UnrealEngine.com/ControlInput:)GetPlayerInput<native><public>(Player:player)<transacts><decides>:(/UnrealEngine.com/ControlInput:)player_input

    @available {MinUploadedAtFNVersion := 3630}
    # This is the main manager class for input-related settings and functions for a player.
    (/UnrealEngine.com/ControlInput:)player_input<native><public> := class:
        AddInputMapping<native><public>(InputMapping:input_mapping):void

        RemoveInputMapping<native><public>(InputMapping:input_mapping):void

        GetInputEvents<native><public>(ActionToBind:input_action(t) where t:type):(/UnrealEngine.com/ControlInput:)input_events(t)


# Module import path: /UnrealEngine.com/BasicShapes
BasicShapes<public> := module:
    using {/Verse.org/SceneGraph}
    cube<public> := class<final><public>(mesh_component):

    sphere<public> := class<final><public>(mesh_component):

    plane<public> := class<final><public>(mesh_component):

    cone<public> := class<final><public>(mesh_component):

    cylinder<public> := class<final><public>(mesh_component):

# Module import path: /UnrealEngine.com/Assets
(/UnrealEngine.com:)Assets<public> := module:
    using {/Verse.org/SpatialMath}
    using {/UnrealEngine.com/Temporary/SpatialMath}
    using {/Verse.org/Assets}
    SpawnParticleSystem<native><public>(Asset:particle_system, Position:(/UnrealEngine.com/Temporary/SpatialMath:)vector3, ?Rotation:(/UnrealEngine.com/Temporary/SpatialMath:)rotation = external {}, ?StartDelay:float = external {})<transacts>:cancelable

    SpawnParticleSystem<native><public>(Asset:particle_system, Position:(/Verse.org/SpatialMath:)vector3, ?Rotation:(/Verse.org/SpatialMath:)rotation = external {}, ?StartDelay:float = external {})<transacts>:cancelable
